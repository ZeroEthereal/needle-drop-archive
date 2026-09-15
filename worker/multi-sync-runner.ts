import { NeteaseClient, NeteaseError } from "../lib/netease";
import { planSnapshotSync } from "../lib/sync/state-machine";
import { commitPlaylistSyncPlan, loadPlaylistSyncState } from "../lib/sync/multi-repository";
import type { Env } from "./env";
import { getInstanceConfig } from "./instance-config";
import { loadNeteaseSession, markNeteaseSessionStatus, storeNeteaseSessionIfBindingCurrent } from "./session-store";
import { verifySnapshotAnomalies } from "./snapshot-verifier";
import { snapshotForStateMachine } from "./sync-runner";

const ACCOUNT_ERRORS = new Set(["authentication", "anonymous", "session_expired", "uid_mismatch", "risk_control"]);

export async function runMonitoredPlaylistSync(env: Env, batchId: string, playlistId: string) {
  const task = await env.DB.prepare(`SELECT status, binding_version FROM sync_playlist_tasks
    WHERE batch_id = ? AND playlist_id = ?`).bind(batchId, playlistId)
    .first<{ status: string; binding_version: number }>();
  if (!task) throw new Error("Sync task no longer exists");
  if (task.status === "success") return { alreadyCompleted: true };
  if (task.status !== "running") throw new Error("Sync task is not running");
  const config = await getInstanceConfig(env);
  if (config.bindingVersion !== task.binding_version || config.status !== "ready" || !config.accountUid)
    throw new Error("Playlist binding changed during sync");
  const playlist = await env.DB.prepare(`SELECT id, baseline_established FROM monitored_playlists WHERE id = ?`)
    .bind(playlistId).first<{ id: string; baseline_established: number }>();
  if (!playlist || playlist.baseline_established !== 1) throw new Error("Playlist baseline is unavailable");
  const phase = async (value: string) => {
    await env.DB.prepare(`UPDATE sync_playlist_tasks SET phase = ?, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND playlist_id = ? AND status = 'running'`)
      .bind(value, batchId, playlistId).run();
  };
  try {
    const stored = await loadNeteaseSession(env);
    if (!stored || stored.status === "reauth_required" || stored.status === "revoked")
      throw new NeteaseError("authentication", "网易云登录态不存在或需要重新授权。");
    const client = new NeteaseClient();
    let login = await client.getLoginStatus(stored.session);
    let refreshed = false;
    if (login.state === "anonymous" || login.state === "expired") {
      const refresh = await client.refreshSession(stored.session);
      refreshed = refresh.status === "refreshed";
      login = refresh.login;
    }
    if (login.state !== "valid" || !login.profile)
      throw new NeteaseError(login.state === "risk_controlled" ? "risk_control" : "session_expired",
        "网易云账号校验失败，请重新授权或稍后重试。");
    if (login.profile.userId !== config.accountUid)
      throw new NeteaseError("uid_mismatch", "当前网易云登录态与绑定账号不一致。");
    const sessionCurrent = await storeNeteaseSessionIfBindingCurrent(env, stored.session,
      config.accountUid, task.binding_version, { validated: true, refreshed });
    if (!sessionCurrent) throw new Error("Playlist binding changed during sync");
    await phase("fetch_playlist");
    const state = await loadPlaylistSyncState(env.DB, playlistId);
    const account = await client.getAccountSnapshot(stored.session, {
      playlistId, expectedUserId: config.accountUid, strictCompleteness: true,
      onPlaylistRead: () => phase("inspect_songs"),
    });
    await phase("compare_snapshot");
    const verified = await verifySnapshotAnomalies(client, stored.session, account, state);
    const plan = planSnapshotSync(snapshotForStateMachine(verified), state, true);
    await phase("persist_snapshot");
    await commitPlaylistSyncPlan(env.DB, playlistId, plan, batchId, task.binding_version);
    return { playlistId, ...plan.result };
  } catch (error) {
    const accountLevel = error instanceof NeteaseError && ACCOUNT_ERRORS.has(error.kind);
    if (accountLevel && error instanceof NeteaseError && error.kind !== "risk_control")
      await markNeteaseSessionStatus(env, "reauth_required").catch(() => undefined);
    await env.DB.prepare(`UPDATE sync_playlist_tasks SET error_code = ?, error_message = ?,
      updated_at = CURRENT_TIMESTAMP WHERE batch_id = ? AND playlist_id = ? AND status = 'running'`)
      .bind(error instanceof NeteaseError ? `NETEASE_${error.kind.toUpperCase()}` : "SYNC_FAILED",
        (error instanceof Error ? error.message : "同步失败").slice(0, 1000), batchId, playlistId)
      .run().catch(() => undefined);
    throw error;
  }
}
