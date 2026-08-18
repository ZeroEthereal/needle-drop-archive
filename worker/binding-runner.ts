import { NeteaseClient } from "../lib/netease";
import { assertCompleteSnapshot, planSnapshotSync } from "../lib/sync";
import type { Env } from "./env";
import { loadNeteaseSession } from "./session-store";
import { verifySnapshotAnomalies } from "./snapshot-verifier";
import { snapshotForStateMachine } from "./sync-runner";

interface PendingBindingRow {
  id: string;
  auth_flow_id: string | null;
  session_id: string;
  account_uid: string;
  account_nickname: string;
  account_avatar_url: string | null;
  playlist_id: string;
  playlist_name: string;
  playlist_cover_url: string | null;
  playlist_owner_uid: string;
  playlist_owner_name: string;
  playlist_owned: number;
  base_binding_version: number;
  status: "preparing" | "running" | "failed";
}

function bindingId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new TypeError("Invalid binding id");
  return value;
}

async function pendingBinding(env: Env, id: string): Promise<PendingBindingRow | null> {
  return env.DB.prepare(`
    SELECT id, auth_flow_id, session_id, account_uid, account_nickname, account_avatar_url,
           playlist_id, playlist_name, playlist_cover_url, playlist_owner_uid,
           playlist_owner_name, playlist_owned, base_binding_version, status
    FROM pending_playlist_bindings WHERE id = ? LIMIT 1
  `).bind(bindingId(id)).first<PendingBindingRow>();
}

const BASELINE_SONGS_SQL = `
  INSERT INTO songs (id, title, artists, album, cover_url, netease_url, created_at, updated_at)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.title'),
         json_extract(value, '$.artists'), json_extract(value, '$.album'),
         json_extract(value, '$.coverUrl'), json_extract(value, '$.neteaseUrl'),
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE EXISTS (
    SELECT 1 FROM instance_config
    WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
  )
`;

const BASELINE_MANAGED_SQL = `
  INSERT INTO managed_songs (
    song_id, bucket, anomaly_type, first_seen_at, last_seen_at,
    last_playable_at, confirmed_at, created_at, updated_at
  )
  SELECT json_extract(value, '$.songId'), json_extract(value, '$.bucket'),
         json_extract(value, '$.anomalyType'),
         json_extract(value, '$.firstSeenAt'), json_extract(value, '$.lastSeenAt'),
         json_extract(value, '$.lastPlayableAt'), json_extract(value, '$.confirmedAt'),
         json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
  FROM json_each(?)
  WHERE EXISTS (
    SELECT 1 FROM instance_config
    WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
  )
`;

export async function runPlaylistBinding(env: Env, rawBindingId: string) {
  const id = bindingId(rawBindingId);
  const pending = await pendingBinding(env, id);
  if (!pending) throw new Error("Playlist binding request no longer exists");
  const marked = await env.DB.prepare(`
    UPDATE pending_playlist_bindings SET status = 'running', error_code = NULL,
      error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('preparing', 'failed')
  `).bind(id).run();
  if (!marked.success) throw new Error(marked.error || "Could not start playlist binding");

  try {
    const stored = await loadNeteaseSession(env, pending.session_id);
    if (!stored || stored.uid !== pending.account_uid) throw new Error("The pending NetEase session is unavailable");
    const client = new NeteaseClient();
    const login = await client.getLoginStatus(stored.session);
    if (login.state !== "valid" || login.profile?.userId !== pending.account_uid) {
      throw new Error("The pending NetEase session is no longer valid");
    }
    const account = await client.getAccountSnapshot(stored.session, {
      playlistId: pending.playlist_id,
      expectedUserId: pending.account_uid,
      strictCompleteness: true,
    });
    if (account.playlist.trackCount <= 0) throw new Error("Empty playlists cannot establish a monitoring baseline");
    const verifiedAccount = await verifySnapshotAnomalies(
      client,
      stored.session,
      account,
      { managedSongs: [] },
    );
    const snapshot = assertCompleteSnapshot(snapshotForStateMachine(verifiedAccount));
    const plan = planSnapshotSync(snapshot, { managedSongs: [] });
    const nextVersion = pending.base_binding_version + 1;
    const activatedAt = new Date().toISOString();
    const runId = `binding-${id}`;
    const guard = [nextVersion, pending.playlist_id, activatedAt] as const;

    const statements = [
      env.DB.prepare(`
        UPDATE instance_config SET
          account_uid = ?, account_nickname = ?, account_avatar_url = ?,
          playlist_id = ?, playlist_name = ?, playlist_cover_url = ?,
          playlist_owner_uid = ?, playlist_owner_name = ?, playlist_owned = ?,
          binding_version = ?, status = 'ready', bound_at = ?, updated_at = ?
        WHERE id = 'primary' AND binding_version = ?
      `).bind(
        pending.account_uid,
        pending.account_nickname,
        pending.account_avatar_url,
        account.playlist.id,
        account.playlist.name,
        account.playlist.coverUrl,
        account.playlist.userId,
        account.playlist.ownerName,
        account.playlist.userId === pending.account_uid ? 1 : 0,
        nextVersion,
        activatedAt,
        activatedAt,
        pending.base_binding_version,
      ),
      env.DB.prepare(`DELETE FROM managed_songs WHERE EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(...guard),
      env.DB.prepare(`DELETE FROM songs WHERE EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(...guard),
      env.DB.prepare(`DELETE FROM sync_runs WHERE EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(...guard),
      env.DB.prepare(`DELETE FROM settings WHERE key = 'manual_sync_queue' AND EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(...guard),
      env.DB.prepare(BASELINE_SONGS_SQL).bind(JSON.stringify(plan.songUpserts), ...guard),
      env.DB.prepare(BASELINE_MANAGED_SQL).bind(JSON.stringify(plan.managedSongUpserts), ...guard),
      env.DB.prepare(`
        INSERT INTO sync_runs (
          id, trigger, status, phase, observed_at, shanghai_date, started_at,
          completed_at, current_song_count, binding_version, created_at, updated_at
        )
        SELECT ?, 'manual', 'success', 'complete', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        WHERE EXISTS (
          SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
        )
      `).bind(
        runId,
        plan.observedAt,
        plan.shanghaiDate,
        activatedAt,
        activatedAt,
        plan.result.currentSongCount,
        nextVersion,
        ...guard,
      ),
      env.DB.prepare(`
        INSERT INTO netease_sessions (
          id, ciphertext, nonce, algorithm, key_version, uid, status, created_at,
          updated_at, last_validated_at, last_refreshed_at
        )
        SELECT 'primary', ciphertext, nonce, algorithm, key_version, uid, 'valid',
               created_at, ?, last_validated_at, last_refreshed_at
        FROM netease_sessions
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
        )
        ON CONFLICT(id) DO UPDATE SET
          ciphertext = excluded.ciphertext, nonce = excluded.nonce,
          algorithm = excluded.algorithm, key_version = excluded.key_version,
          uid = excluded.uid, status = 'valid', updated_at = excluded.updated_at,
          last_validated_at = excluded.last_validated_at,
          last_refreshed_at = excluded.last_refreshed_at
      `).bind(activatedAt, pending.session_id, ...guard),
    ];
    if (pending.auth_flow_id) {
      statements.push(env.DB.prepare(`DELETE FROM netease_auth_flows WHERE id = ? AND EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(pending.auth_flow_id, ...guard));
    }
    statements.push(
      env.DB.prepare(`DELETE FROM pending_playlist_bindings WHERE id = ? AND EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(id, ...guard),
    );
    if (pending.session_id !== "primary") {
      statements.push(env.DB.prepare(`DELETE FROM netease_sessions WHERE id = ? AND EXISTS (
        SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND playlist_id = ? AND updated_at = ?
      )`).bind(pending.session_id, ...guard));
    }

    const results = await env.DB.batch(statements);
    const failed = results.find((result) => !result.success);
    if (failed) throw new Error(failed.error || "D1 rejected the playlist binding transaction");
    if ((results[0].meta?.changes ?? 0) !== 1) {
      throw new Error("The playlist binding was superseded by a newer configuration");
    }
    return { bindingId: id, bindingVersion: nextVersion, songCount: plan.result.currentSongCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playlist baseline preparation failed";
    await env.DB.prepare(`
      UPDATE pending_playlist_bindings SET status = 'failed', error_code = 'BINDING_FAILED',
        error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(message.slice(0, 500), id).run().catch(() => undefined);
    throw error;
  }
}
