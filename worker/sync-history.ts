import type { SyncHistoryRecord } from "../app/ui-types";

const PAGE_SIZE = 10;

interface HistoryBatch {
  id: string;
  trigger: "manual" | "scheduled";
  scope: "all" | "playlist";
  status: "success" | "failed";
  playlist_count: number;
  completed_at: string;
}

interface HistoryTask {
  batch_id: string;
  playlist_id: string;
  playlist_name: string;
  status: string;
}

export async function listSyncHistory(db: D1Database, offset: number, now = new Date()) {
  // Shanghai uses UTC+8. Include today and the preceding six calendar days.
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const midnight = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(),
    shanghai.getUTCDate(), -8);
  const from = new Date(midnight - 6 * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(midnight + 24 * 60 * 60 * 1000).toISOString();
  const where = `status IN ('success', 'failed') AND completed_at IS NOT NULL
    AND datetime(completed_at) >= datetime(?) AND datetime(completed_at) < datetime(?)`;
  const [count, page] = await db.batch<HistoryBatch | { total: number }>([
    db.prepare(`SELECT COUNT(*) AS total FROM sync_batches WHERE ${where}`).bind(from, until),
    db.prepare(`SELECT id, trigger, scope, status, playlist_count, completed_at
      FROM sync_batches WHERE ${where}
      ORDER BY datetime(completed_at) DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(from, until, PAGE_SIZE, offset),
  ]);
  if (!count.success || !page.success) throw new Error("Could not load sync history");
  const countRow = count.results[0];
  const total = countRow && "total" in countRow ? Number(countRow.total) : 0;
  const batches = page.results.filter((row): row is HistoryBatch => "id" in row);
  let tasks: HistoryTask[] = [];
  if (batches.length) {
    const result = await db.prepare(`SELECT batch_id, playlist_id, playlist_name, status
      FROM sync_playlist_tasks WHERE batch_id IN (${batches.map(() => "?").join(",")})
      ORDER BY list_order, playlist_id`).bind(...batches.map((batch) => batch.id))
      .all<HistoryTask>();
    if (!result.success) throw new Error(result.error || "Could not load sync history playlists");
    tasks = result.results;
  }
  const items: SyncHistoryRecord[] = batches.map((batch) => {
    const entries = tasks.filter((task) => task.batch_id === batch.id);
    const failedPlaylists = entries.filter((task) => task.status !== "success")
      .map((task) => ({ id: task.playlist_id, name: task.playlist_name }));
    const successful = batch.status === "success" && entries.length === batch.playlist_count
      && failedPlaylists.length === 0;
    const playlist = batch.scope === "playlist" && entries[0]
      ? { id: entries[0].playlist_id, name: entries[0].playlist_name } : undefined;
    return {
      id: batch.id, trigger: batch.trigger, scope: batch.scope,
      completedAt: batch.completed_at, status: successful ? "success" : "failed",
      playlistCount: batch.playlist_count, failureCount: failedPlaylists.length,
      playlist, failedPlaylists,
    };
  });
  return { items, total, nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null };
}
