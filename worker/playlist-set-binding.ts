import type { WorkflowStep } from "cloudflare:workers";
import { NeteaseClient } from "../lib/netease";
import { assertCompleteSnapshot, planSnapshotSync } from "../lib/sync/state-machine";
import { defaultPlaylist, listMonitoredPlaylists } from "../lib/sync/multi-repository";
import type { Env } from "./env";
import { getInstanceConfig } from "./instance-config";
import { loadNeteaseSession } from "./session-store";
import { snapshotForStateMachine } from "./sync-runner";
import { verifySnapshotAnomalies } from "./snapshot-verifier";

export interface PlaylistSelection {
  id: string; name: string; coverUrl: string | null; ownerUid: string;
  ownerName: string; owned: boolean; specialType: number | null; listOrder: number;
}

interface PendingSet {
  id: string; auth_flow_id: string | null; session_id: string; account_uid: string;
  account_nickname: string; account_avatar_url: string | null; playlist_json: string;
  base_binding_version: number; status: string; workflow_id: string | null;
}

function pendingSelection(pending: PendingSet): { playlists: PlaylistSelection[]; freshBaseline: boolean } {
  const raw = JSON.parse(pending.playlist_json) as PlaylistSelection[] | {
    playlists: PlaylistSelection[]; freshBaseline?: boolean;
  };
  const playlists = Array.isArray(raw) ? raw : raw.playlists;
  if (!Array.isArray(playlists) || playlists.length < 1 || playlists.length > 20)
    throw new Error("Pending playlist selection is invalid");
  return { playlists, freshBaseline: !Array.isArray(raw) && raw.freshBaseline === true };
}

async function loadPending(env: Env, id: string): Promise<PendingSet> {
  const row = await env.DB.prepare(`SELECT * FROM pending_playlist_sets WHERE id = ?`)
    .bind(id).first<PendingSet>();
  if (!row) throw new Error("Playlist selection request no longer exists");
  return row;
}

export async function preparePlaylistBaseline(env: Env, bindingId: string, playlistId: string) {
  const pending = await loadPending(env, bindingId);
  const selections = pendingSelection(pending).playlists;
  if (!selections.some((playlist) => playlist.id === playlistId))
    throw new Error("Playlist is not part of this selection");
  const existing = await env.DB.prepare(`SELECT playlist_id FROM pending_playlist_baselines
    WHERE binding_id = ? AND playlist_id = ?`).bind(bindingId, playlistId)
    .first<{ playlist_id: string }>();
  if (existing) return { playlistId, staged: true };
  const stored = await loadNeteaseSession(env, pending.session_id);
  if (!stored || stored.uid !== pending.account_uid) throw new Error("Pending NetEase session is unavailable");
  const client = new NeteaseClient();
  const login = await client.getLoginStatus(stored.session);
  if (login.state !== "valid" || login.profile?.userId !== pending.account_uid)
    throw new Error("Pending NetEase session is not valid for the selected account");
  const account = await client.getAccountSnapshot(stored.session, {
    playlistId, expectedUserId: pending.account_uid, strictCompleteness: true,
  });
  if (account.playlist.trackCount <= 0)
    throw new Error("Empty playlists cannot establish a monitoring baseline");
  const verified = await verifySnapshotAnomalies(client, stored.session, account,
    { managedSongs: [] });
  const snapshot = assertCompleteSnapshot(snapshotForStateMachine(verified));
  const plan = planSnapshotSync(snapshot, { managedSongs: [] }, false);
  const result = await env.DB.prepare(`INSERT INTO pending_playlist_baselines
    (binding_id, playlist_id, song_json, state_json, verified_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(binding_id, playlist_id) DO NOTHING`)
    .bind(bindingId, playlistId,
      JSON.stringify(plan.songUpserts.map((song) => ({ ...song, artists: JSON.stringify(song.artists) }))),
      JSON.stringify(plan.managedSongUpserts), plan.observedAt).run();
  if (!result.success) throw new Error(result.error || "Could not stage playlist baseline");
  return { playlistId, staged: true, songCount: plan.result.currentSongCount };
}

async function notifyBinding(env: Env, pending: PendingSet, playlistId: string, status: string) {
  if (!pending.workflow_id || !env.MUSIC_BATCH) return;
  const instance = await env.MUSIC_BATCH.get(pending.workflow_id);
  await instance.sendEvent({ type: `baseline-${playlistId}`,
    payload: { playlistId, status } });
}

export async function runBaselineChild(env: Env, bindingId: string, playlistId: string,
  step: WorkflowStep) {
  const pending = await loadPending(env, bindingId);
  try {
    const result = await step.do(`prepare baseline ${playlistId}`, {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
      timeout: "15 minutes",
    }, async () => preparePlaylistBaseline(env, bindingId, playlistId));
    await notifyBinding(env, pending, playlistId, "success");
    return result;
  } catch (error) {
    await env.DB.prepare(`UPDATE pending_playlist_sets SET error_code = 'BASELINE_FAILED',
      error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind((error instanceof Error ? error.message : "歌单基线准备失败").slice(0, 1000), bindingId)
      .run().catch(() => undefined);
    await notifyBinding(env, pending, playlistId, "failed").catch(() => undefined);
    throw error;
  }
}

async function activateSelection(env: Env, pending: PendingSet, selections: PlaylistSelection[]) {
  const current = await getInstanceConfig(env);
  if (current.bindingVersion !== pending.base_binding_version)
    throw new Error("A newer playlist selection superseded this request");
  const replacingAccount = current.accountUid !== pending.account_uid;
  const freshBaseline = pendingSelection(pending).freshBaseline;
  const currentPlaylists = replacingAccount || freshBaseline ? [] : await listMonitoredPlaylists(env.DB);
  const preserved = new Set(currentPlaylists.map((item) => item.id));
  const added = selections.filter((item) => !preserved.has(item.id));
  const stageResult = await env.DB.prepare(`SELECT playlist_id, song_json, state_json
    FROM pending_playlist_baselines WHERE binding_id = ?`).bind(pending.id)
    .all<{ playlist_id: string; song_json: string; state_json: string }>();
  if (!stageResult.success) throw new Error(stageResult.error || "Could not read staged baselines");
  const staged = new Map((stageResult.results ?? []).map((row) => [row.playlist_id, row]));
  if (added.some((item) => !staged.has(item.id)))
    throw new Error("A selected playlist has no complete staged baseline");
  const candidate = selections.map((selection) => {
    const old = currentPlaylists.find((item) => item.id === selection.id);
    const baseline = staged.get(selection.id);
    const stagedStates = baseline ? JSON.parse(baseline.state_json) as Array<{
      bucket: string; anomalyType: string | null;
    }> : [];
    const stagedCount = stagedStates.length;
    return { ...selection, totalSongCount: old?.totalSongCount ?? stagedCount,
      normalCount: old?.normalCount ?? stagedStates.filter((state) => state.bucket === "normal").length,
      missingCount: old?.missingCount ?? stagedStates.filter((state) => state.anomalyType === "missing").length,
      greyCount: old?.greyCount ?? stagedStates.filter((state) => state.anomalyType === "grey").length,
      baselineEstablished: true, boundAt: old?.boundAt ?? new Date().toISOString() };
  });
  const primary = defaultPlaylist(candidate);
  if (!primary) throw new Error("Playlist selection cannot be empty");
  const nextVersion = current.bindingVersion + 1;
  const now = new Date().toISOString();
  const guard = `EXISTS (SELECT 1 FROM instance_config WHERE id = 'primary'
    AND binding_version = ? AND account_uid = ?)`;
  const statements = [
    env.DB.prepare(`UPDATE instance_config SET account_uid = ?, account_nickname = ?,
      account_avatar_url = ?, playlist_id = ?, playlist_name = ?, playlist_cover_url = ?,
      playlist_owner_uid = ?, playlist_owner_name = ?, playlist_owned = ?,
      binding_version = ?, status = 'ready', bound_at = ?, updated_at = ?
      WHERE id = 'primary' AND binding_version = ?`).bind(pending.account_uid,
      pending.account_nickname, pending.account_avatar_url, primary.id, primary.name,
      primary.coverUrl, primary.ownerUid, primary.ownerName, primary.owned ? 1 : 0,
      nextVersion, now, now, pending.base_binding_version),
  ];
  if (replacingAccount || freshBaseline) {
    statements.push(env.DB.prepare(`DELETE FROM monitored_playlists WHERE ${guard}`)
      .bind(nextVersion, pending.account_uid));
  } else {
    statements.push(env.DB.prepare(`DELETE FROM monitored_playlists WHERE id NOT IN
      (SELECT value FROM json_each(?)) AND ${guard}`)
      .bind(JSON.stringify(selections.map((item) => item.id)), nextVersion, pending.account_uid));
  }
  for (const item of selections) {
    statements.push(env.DB.prepare(`INSERT INTO monitored_playlists
      (id, name, cover_url, owner_uid, owner_name, owned, special_type,
       list_order, baseline_established, bound_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ? WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, cover_url = excluded.cover_url,
        owner_uid = excluded.owner_uid, owner_name = excluded.owner_name,
        owned = excluded.owned, special_type = excluded.special_type,
        list_order = excluded.list_order, updated_at = CURRENT_TIMESTAMP`)
      .bind(item.id, item.name, item.coverUrl, item.ownerUid, item.ownerName,
        item.owned ? 1 : 0, item.specialType, item.listOrder, now,
        nextVersion, pending.account_uid));
  }
  for (const item of added) {
    const row = staged.get(item.id)!;
    statements.push(env.DB.prepare(`INSERT INTO songs
      (id, title, artists, album, cover_url, netease_url, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.title'),
        json_extract(value, '$.artists'), json_extract(value, '$.album'),
        json_extract(value, '$.coverUrl'), json_extract(value, '$.neteaseUrl'),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM json_each(?) WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, artists = excluded.artists,
        album = excluded.album, cover_url = excluded.cover_url,
        netease_url = excluded.netease_url, updated_at = CURRENT_TIMESTAMP`)
      .bind(row.song_json, nextVersion, pending.account_uid));
    statements.push(env.DB.prepare(`INSERT INTO playlist_song_states
      (playlist_id, song_id, bucket, anomaly_type, first_seen_at, last_seen_at,
       last_confirmed_at, last_playable_at, confirmed_at, created_at, updated_at)
      SELECT ?, json_extract(value, '$.songId'), json_extract(value, '$.bucket'),
        json_extract(value, '$.anomalyType'), json_extract(value, '$.firstSeenAt'),
        json_extract(value, '$.lastSeenAt'), json_extract(value, '$.lastConfirmedAt'),
        json_extract(value, '$.lastPlayableAt'), json_extract(value, '$.confirmedAt'),
        json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
      FROM json_each(?) WHERE ${guard}`)
      .bind(item.id, row.state_json, nextVersion, pending.account_uid));
  }
  if (pending.session_id !== "primary") {
    statements.push(env.DB.prepare(`INSERT INTO netease_sessions
      (id, ciphertext, nonce, algorithm, key_version, uid, status, created_at,
       updated_at, last_validated_at, last_refreshed_at)
      SELECT 'primary', ciphertext, nonce, algorithm, key_version, uid, 'valid',
        created_at, ?, last_validated_at, last_refreshed_at
      FROM netease_sessions WHERE id = ? AND ${guard}
      ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext,
        nonce = excluded.nonce, algorithm = excluded.algorithm,
        key_version = excluded.key_version, uid = excluded.uid,
        status = 'valid', updated_at = excluded.updated_at,
        last_validated_at = excluded.last_validated_at,
        last_refreshed_at = excluded.last_refreshed_at`)
      .bind(now, pending.session_id, nextVersion, pending.account_uid));
  }
  if (freshBaseline) {
    statements.push(env.DB.prepare(`DELETE FROM managed_songs WHERE ${guard}`)
      .bind(nextVersion, pending.account_uid));
    statements.push(env.DB.prepare(`DELETE FROM sync_runs WHERE ${guard}`)
      .bind(nextVersion, pending.account_uid));
    statements.push(env.DB.prepare(`DELETE FROM settings WHERE key = 'manual_sync_queue'
      AND ${guard}`).bind(nextVersion, pending.account_uid));
  }
  statements.push(env.DB.prepare(`DELETE FROM songs WHERE id NOT IN
    (SELECT song_id FROM playlist_song_states) AND ${guard}`)
    .bind(nextVersion, pending.account_uid));
  // Results for the former playlist set cannot be presented as a batch for the
  // new binding; task history is intentionally discarded on selection changes.
  statements.push(env.DB.prepare(`DELETE FROM sync_batches WHERE status NOT IN ('queued', 'running')
    AND ${guard}`).bind(nextVersion, pending.account_uid));
  statements.push(env.DB.prepare(`DELETE FROM pending_playlist_sets WHERE id = ? AND ${guard}`)
    .bind(pending.id, nextVersion, pending.account_uid));
  if (pending.auth_flow_id) statements.push(env.DB.prepare(`DELETE FROM netease_auth_flows
    WHERE id = ? AND ${guard}`).bind(pending.auth_flow_id, nextVersion, pending.account_uid));
  if (pending.session_id !== "primary") statements.push(env.DB.prepare(`DELETE FROM netease_sessions
    WHERE id = ? AND ${guard}`).bind(pending.session_id, nextVersion, pending.account_uid));
  const result = await env.DB.batch(statements);
  const failed = result.find((row) => !row.success);
  if (failed) throw new Error(failed.error || "D1 rejected playlist selection transaction");
  if ((result[0].meta?.changes ?? 0) !== 1)
    throw new Error("Playlist selection was superseded by a newer version");
  return { bindingVersion: nextVersion, playlistCount: selections.length };
}

export async function runPlaylistSetBinding(env: Env, bindingId: string, step: WorkflowStep) {
  const pending = await loadPending(env, bindingId);
  const { playlists: selections, freshBaseline } = pendingSelection(pending);
  const current = await getInstanceConfig(env);
  const replacingAccount = current.accountUid !== pending.account_uid;
  const monitored = replacingAccount || freshBaseline ? [] : await listMonitoredPlaylists(env.DB);
  const preserved = new Set(monitored.map((item) => item.id));
  const added = selections.filter((item) => !preserved.has(item.id));
  if (!env.MUSIC_SYNC) throw new Error("MUSIC_SYNC workflow binding is unavailable");
  let claimed = false;
  for (let attempt = 0; attempt < 1440 && !claimed; attempt += 1) {
    claimed = await step.do(`claim binding ${attempt}`, async () => {
      const result = await env.DB.prepare(`UPDATE pending_playlist_sets SET status = 'running',
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('preparing', 'failed')
        AND NOT EXISTS (SELECT 1 FROM sync_batches WHERE status = 'running')
        AND NOT EXISTS (SELECT 1 FROM pending_playlist_sets
          WHERE status = 'running' AND id <> ?)`)
        .bind(bindingId, bindingId).run();
      if (!result.success) throw new Error(result.error || "Could not claim playlist binding");
      return (result.meta?.changes ?? 0) === 1;
    });
    if (!claimed) await step.sleep(`wait binding lock ${attempt}`, "1 minute");
  }
  if (!claimed) throw new Error("Playlist binding was not started within a day");
  try {
    for (const item of added) {
      const childId = `baseline-${bindingId}-${item.id}`;
      await step.do(`dispatch baseline ${item.id}`, async () => {
        try {
          await env.MUSIC_SYNC!.create({ id: childId,
            params: { action: "prepare_playlist_baseline", bindingId, playlistId: item.id } });
        } catch (error) {
          const existing = await env.MUSIC_SYNC!.get(childId).catch(() => null);
          if (!existing) throw error;
        }
      });
      try {
        const event = await step.waitForEvent<{ status: string }>(`wait baseline ${item.id}`,
          { type: `baseline-${item.id}`, timeout: "1 hour" });
        if (event.payload.status !== "success") throw new Error(`歌单 ${item.name} 的基线准备失败`);
      } catch (error) {
        const staged = await env.DB.prepare(`SELECT playlist_id FROM pending_playlist_baselines
          WHERE binding_id = ? AND playlist_id = ?`).bind(bindingId, item.id)
          .first<{ playlist_id: string }>();
        if (!staged) throw error;
      }
    }
    return step.do("atomically activate complete playlist selection", {
      retries: { limit: 2, delay: "30 seconds" }, timeout: "10 minutes",
    }, async () => activateSelection(env, pending, selections));
  } catch (error) {
    await env.DB.prepare(`UPDATE pending_playlist_sets SET status = 'failed',
      error_code = COALESCE(error_code, 'BINDING_FAILED'),
      error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind((error instanceof Error ? error.message : "歌单选择失败").slice(0, 1000), bindingId)
      .run().catch(() => undefined);
    throw error;
  }
}
