import type { Env } from "./env";
import { ensureInstanceConfig, getInstanceConfig } from "./instance-config";
import { listMonitoredPlaylists } from "../lib/sync/multi-repository";

export type BatchTrigger = "manual" | "scheduled";

export async function createSyncBatch(env: Env, trigger: BatchTrigger, playlistId?: string): Promise<string> {
  const config = await ensureInstanceConfig(env);
  if (config.status !== "ready" || !config.accountUid) throw new Error("INSTANCE_NOT_CONFIGURED");
  const all = await listMonitoredPlaylists(env.DB);
  const selected = playlistId ? all.filter((playlist) => playlist.id === playlistId) : all;
  if (!selected.length || (playlistId && !all.some((playlist) => playlist.id === playlistId)))
    throw new Error("PLAYLIST_NOT_MONITORED");
  if (trigger === "manual") {
    const active = await env.DB.prepare(`SELECT id FROM sync_batches WHERE status IN ('queued', 'running') LIMIT 1`)
      .first<{ id: string }>();
    if (active) throw new Error("SYNC_IN_PROGRESS");
    const binding = await env.DB.prepare(`SELECT id FROM pending_playlist_sets
      WHERE status IN ('preparing', 'running') LIMIT 1`).first<{ id: string }>();
    if (binding) throw new Error("SYNC_IN_PROGRESS");
  }
  const id = trigger === "scheduled"
    ? `scheduled-${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric",
      month: "2-digit", day: "2-digit" }).format(new Date())}`
    : crypto.randomUUID();
  const insertBatch = trigger === "manual"
    ? `INSERT INTO sync_batches (id, trigger, scope, status, binding_version,
        account_uid, playlist_count, workflow_id)
       SELECT ?, ?, ?, 'queued', ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM sync_batches WHERE status IN ('queued', 'running'))
         AND NOT EXISTS (SELECT 1 FROM pending_playlist_sets
           WHERE status IN ('preparing', 'running'))
       ON CONFLICT(id) DO NOTHING`
    : `INSERT INTO sync_batches (id, trigger, scope, status, binding_version,
        account_uid, playlist_count, workflow_id)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`;
  const statements = [
    env.DB.prepare(insertBatch).bind(id, trigger, playlistId ? "playlist" : "all", config.bindingVersion,
        config.accountUid, selected.length, `batch-${id}`),
    ...selected.map((playlist) => env.DB.prepare(`INSERT INTO sync_playlist_tasks
      (batch_id, playlist_id, list_order, playlist_name, status, binding_version)
      SELECT ?, ?, ?, ?, 'unexecuted', ?
      WHERE EXISTS (SELECT 1 FROM sync_batches WHERE id = ?)
      ON CONFLICT(batch_id, playlist_id) DO NOTHING`).bind(id, playlist.id, playlist.listOrder,
        playlist.name, config.bindingVersion, id)),
    env.DB.prepare(`DELETE FROM sync_batches WHERE created_at < datetime('now', '-30 days')
      AND status NOT IN ('queued', 'running')`),
  ];
  const results = await env.DB.batch(statements);
  const failed = results.find((row) => !row.success);
  if (failed) throw new Error(failed.error || "Could not queue sync batch");
  if (trigger === "manual" && (results[0].meta?.changes ?? 0) !== 1)
    throw new Error("SYNC_IN_PROGRESS");
  if (!env.MUSIC_BATCH) throw new Error("MUSIC_BATCH workflow binding is unavailable");
  try {
    const workflow = await env.MUSIC_BATCH.create({ id: `batch-${id}`,
      params: { action: "sync_batch", batchId: id } });
    await env.DB.prepare(`UPDATE sync_batches SET workflow_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(workflow.id, id).run();
  } catch (error) {
    const instance = await env.MUSIC_BATCH.get(`batch-${id}`).catch(() => null);
    if (!instance) {
      await env.DB.prepare(`UPDATE sync_batches SET status = 'failed',
        error_code = 'WORKFLOW_DISPATCH_FAILED', error_message = ?,
        completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`)
        .bind((error instanceof Error ? error.message : "Workflow 派发失败").slice(0, 500), id)
        .run().catch(() => undefined);
      throw error;
    }
  }
  return id;
}

export async function latestBatchStatus(env: Env) {
  const batch = await env.DB.prepare(`SELECT * FROM sync_batches
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      datetime(created_at) DESC, id DESC LIMIT 1`).first<Record<string, unknown>>();
  if (!batch) return null;
  const tasks = await env.DB.prepare(`SELECT * FROM sync_playlist_tasks
    WHERE batch_id = ? ORDER BY list_order, playlist_id`).bind(batch.id).all<Record<string, unknown>>();
  if (!tasks.success) throw new Error(tasks.error || "Could not read sync tasks");
  const entries = tasks.results ?? [];
  const enrichedBatch: Record<string, unknown> = {
    ...batch,
    success_count: entries.filter((task) => task.status === "success").length,
    failure_count: entries.filter((task) => task.status === "failed").length,
    unexecuted_count: entries.filter((task) => task.status === "unexecuted").length,
  };
  return { batch: enrichedBatch, tasks: entries };
}

export async function latestCompletedBatch(env: Env) {
  const batch = await env.DB.prepare(`SELECT * FROM sync_batches WHERE status IN ('success', 'failed')
    ORDER BY datetime(completed_at) DESC, id DESC LIMIT 1`).first<Record<string, unknown>>();
  if (!batch) return null;
  const tasks = await env.DB.prepare(`SELECT * FROM sync_playlist_tasks WHERE batch_id = ?
    ORDER BY list_order, playlist_id`).bind(batch.id).all<Record<string, unknown>>();
  if (!tasks.success) throw new Error(tasks.error || "Could not load completed batch");
  return { ...batch, tasks: tasks.results ?? [] };
}

export async function latestPlaylistTask(env: Env, playlistId: string) {
  return env.DB.prepare(`SELECT t.* FROM sync_playlist_tasks t
    JOIN sync_batches b ON b.id = t.batch_id WHERE t.playlist_id = ?
    ORDER BY datetime(b.created_at) DESC, b.id DESC LIMIT 1`).bind(playlistId)
    .first<Record<string, unknown>>();
}

export async function summarizeBatch(env: Env, id: string) {
  const counts = await env.DB.prepare(`SELECT
    SUM(status = 'success') AS success_count,
    SUM(status = 'failed') AS failure_count,
    SUM(status = 'unexecuted') AS unexecuted_count
    FROM sync_playlist_tasks WHERE batch_id = ?`).bind(id)
    .first<{ success_count: number; failure_count: number; unexecuted_count: number }>();
  await env.DB.prepare(`UPDATE sync_batches SET status = ?, success_count = ?,
    failure_count = ?, unexecuted_count = ?, current_playlist_id = NULL,
    completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(Number(counts?.failure_count || 0) > 0 || Number(counts?.unexecuted_count || 0) > 0
      ? "failed" : "success", Number(counts?.success_count || 0),
      Number(counts?.failure_count || 0), Number(counts?.unexecuted_count || 0), id).run();
}

export async function refreshScheduledBatchSelection(env: Env, id: string) {
  const batch = await env.DB.prepare(`SELECT trigger, binding_version FROM sync_batches
    WHERE id = ? AND status = 'running'`).bind(id)
    .first<{ trigger: string; binding_version: number }>();
  if (!batch) throw new Error("Running batch no longer exists");
  const config = await getInstanceConfig(env);
  if (config.bindingVersion === batch.binding_version) return;
  if (batch.trigger !== "scheduled" || config.status !== "ready" || !config.accountUid)
    throw new Error("Playlist binding changed before batch execution");
  const playlists = await listMonitoredPlaylists(env.DB);
  if (!playlists.length) throw new Error("No monitored playlists remain for the scheduled batch");
  const statements = [
    env.DB.prepare(`UPDATE sync_batches SET binding_version = ?, account_uid = ?,
      playlist_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      AND status = 'running' AND binding_version = ?`)
      .bind(config.bindingVersion, config.accountUid, playlists.length, id, batch.binding_version),
    env.DB.prepare(`DELETE FROM sync_playlist_tasks WHERE batch_id = ? AND EXISTS (
      SELECT 1 FROM sync_batches WHERE id = ? AND binding_version = ? AND status = 'running')`)
      .bind(id, id, config.bindingVersion),
    ...playlists.map((playlist) => env.DB.prepare(`INSERT INTO sync_playlist_tasks
      (batch_id, playlist_id, list_order, playlist_name, status, binding_version)
      SELECT ?, ?, ?, ?, 'unexecuted', ? WHERE EXISTS (
        SELECT 1 FROM sync_batches WHERE id = ? AND binding_version = ? AND status = 'running')`)
      .bind(id, playlist.id, playlist.listOrder, playlist.name, config.bindingVersion,
        id, config.bindingVersion)),
  ];
  const results = await env.DB.batch(statements);
  const failed = results.find((row) => !row.success);
  if (failed) throw new Error(failed.error || "Could not update scheduled playlist selection");
  if ((results[0].meta?.changes ?? 0) !== 1)
    throw new Error("Scheduled batch playlist selection changed concurrently");
}
