import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "./env";
import { runMusicSync } from "./sync-runner";
import { runPlaylistBinding } from "./binding-runner";
import { runMonitoredPlaylistSync } from "./multi-sync-runner";
import { refreshScheduledBatchSelection, summarizeBatch } from "./sync-batches";
import { runBaselineChild, runPlaylistSetBinding } from "./playlist-set-binding";

export type MusicSyncParams =
  | { action?: "sync"; source?: "manual" | "scheduled" }
  | { action: "bind_playlist"; bindingId: string }
  | { action: "sync_playlist"; batchId: string; playlistId: string }
  | { action: "prepare_playlist_baseline"; bindingId: string; playlistId: string };

/**
 * Durable entrypoint used by both the daily Cron Trigger and the manual sync
 * button. A failed upstream response never commits a snapshot; retrying the
 * step is therefore safe and remains idempotent per Shanghai day.
 */
export class MusicSyncWorkflow extends WorkflowEntrypoint<Env, MusicSyncParams> {
  async run(event: WorkflowEvent<MusicSyncParams>, step: WorkflowStep) {
    if (event.payload?.action === "prepare_playlist_baseline") {
      return runBaselineChild(this.env, event.payload.bindingId,
        event.payload.playlistId, step);
    }
    if (event.payload?.action === "sync_playlist") {
      const { batchId, playlistId } = event.payload;
      try {
        const result = await step.do(`sync playlist ${playlistId}`, {
          retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
          timeout: "15 minutes",
        }, async () => runMonitoredPlaylistSync(this.env, batchId, playlistId));
        await notifyBatch(this.env, batchId, playlistId, "success");
        return result;
      } catch (error) {
        await this.env.DB.prepare(`UPDATE sync_playlist_tasks SET status = 'failed',
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE batch_id = ? AND playlist_id = ? AND status = 'running'`)
          .bind(batchId, playlistId).run();
        await notifyBatch(this.env, batchId, playlistId, "failed");
        throw error;
      }
    }
    if (event.payload?.action === "bind_playlist") {
      const bindingId = event.payload.bindingId;
      return step.do(
        "validate the complete playlist and atomically switch the binding",
        {
          retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
          timeout: "15 minutes",
          sensitive: "output",
        },
        async () => runPlaylistBinding(this.env, bindingId),
      );
    }
    const trigger = event.schedule ? "scheduled" : (event.payload?.source ?? "manual");

    return step.do(
      "validate, read and atomically compare the complete playlist",
      {
        retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
        timeout: "10 minutes",
        sensitive: "output",
      },
      async () => runMusicSync(this.env, trigger),
    );
  }
}

async function notifyBatch(env: Env, batchId: string, playlistId: string, status: string) {
  if (!env.MUSIC_BATCH) return;
  const batch = await env.DB.prepare(`SELECT workflow_id FROM sync_batches WHERE id = ?`)
    .bind(batchId).first<{ workflow_id: string | null }>();
  if (!batch?.workflow_id) return;
  const instance = await env.MUSIC_BATCH.get(batch.workflow_id);
  await instance.sendEvent({ type: `task-${playlistId}`, payload: { playlistId, status } });
}

export type MusicBatchParams =
  | { action: "sync_batch"; batchId: string }
  | { action: "bind_playlist_set"; bindingId: string };

export class MusicBatchWorkflow extends WorkflowEntrypoint<Env, MusicBatchParams> {
  async run(event: WorkflowEvent<MusicBatchParams>, step: WorkflowStep) {
    if (event.payload.action === "bind_playlist_set") {
      return runPlaylistSetBinding(this.env, event.payload.bindingId, step);
    }
    const batchId = event.payload.batchId;
    let claimed = false;
    for (let attempt = 0; attempt < 1440 && !claimed; attempt += 1) {
      claimed = await step.do(`claim batch ${attempt}`, async () => {
        const result = await this.env.DB.prepare(`UPDATE sync_batches SET status = 'running',
          started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'queued'
            AND NOT EXISTS (SELECT 1 FROM sync_batches WHERE status = 'running' AND id <> ?)
            AND NOT EXISTS (SELECT 1 FROM pending_playlist_sets WHERE status = 'running')
            AND NOT EXISTS (SELECT 1 FROM sync_batches q WHERE q.status = 'queued'
              AND (q.created_at < (SELECT created_at FROM sync_batches WHERE id = ?)
                OR (q.created_at = (SELECT created_at FROM sync_batches WHERE id = ?) AND q.id < ?)))`)
          .bind(batchId, batchId, batchId, batchId, batchId).run();
        if (!result.success) throw new Error(result.error || "Cannot claim sync batch");
        return (result.meta?.changes ?? 0) === 1;
      });
      if (!claimed) await step.sleep(`wait for earlier batch ${attempt}`, "1 minute");
    }
    if (!claimed) throw new Error("Batch was not started within a day");
    try {
      await step.do("refresh scheduled selection after binding", async () =>
        refreshScheduledBatchSelection(this.env, batchId));
      const tasks = await step.do("list serial playlist tasks", async () => {
        const result = await this.env.DB.prepare(`SELECT playlist_id, status
          FROM sync_playlist_tasks WHERE batch_id = ? ORDER BY list_order, playlist_id`)
          .bind(batchId).all<{ playlist_id: string; status: string }>();
        if (!result.success) throw new Error(result.error || "Cannot list batch tasks");
        return result.results ?? [];
      });
      if (!this.env.MUSIC_SYNC) throw new Error("MUSIC_SYNC workflow binding is unavailable");
      let stopForAccount = false;
      for (const task of tasks) {
        if (stopForAccount) break;
        const playlistId = task.playlist_id;
        const childId = `playlist-${batchId}-${playlistId}`;
        try {
          await step.do(`dispatch playlist ${playlistId}`, async () => {
            await this.env.DB.prepare(`UPDATE sync_playlist_tasks SET status = 'running',
              phase = 'validate_session', started_at = CURRENT_TIMESTAMP,
              workflow_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE batch_id = ? AND playlist_id = ? AND status = 'unexecuted'`)
              .bind(childId, batchId, playlistId).run();
            await this.env.DB.prepare(`UPDATE sync_batches SET current_playlist_id = ?,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(playlistId, batchId).run();
            try {
              await this.env.MUSIC_SYNC!.create({ id: childId,
                params: { action: "sync_playlist", batchId, playlistId } });
            } catch (error) {
              const instance = await this.env.MUSIC_SYNC!.get(childId).catch(() => null);
              if (!instance) throw error;
            }
          });
          await step.waitForEvent(`wait for playlist ${playlistId}`, {
            type: `task-${playlistId}`, timeout: "1 hour",
          });
        } catch (error) {
          const instance = await this.env.MUSIC_SYNC.get(childId).catch(() => null);
          const status = await instance?.status().catch(() => null);
          if (status?.status !== "complete") await this.env.DB.prepare(`UPDATE sync_playlist_tasks
            SET status = 'failed', error_code = COALESCE(error_code, 'WORKFLOW_DISPATCH_OR_WAIT_FAILED'),
              error_message = COALESCE(error_message, ?), completed_at = CURRENT_TIMESTAMP
            WHERE batch_id = ? AND playlist_id = ? AND status IN ('unexecuted', 'running')`)
            .bind((error instanceof Error ? error.message : "歌单 Workflow 未能完成").slice(0, 500),
              batchId, playlistId).run();
        }
        const outcome = await step.do(`read playlist result ${playlistId}`, async () =>
          this.env.DB.prepare(`SELECT status, error_code FROM sync_playlist_tasks
            WHERE batch_id = ? AND playlist_id = ?`).bind(batchId, playlistId)
            .first<{ status: string; error_code: string | null }>());
        stopForAccount = outcome?.status === "failed" && Boolean(outcome.error_code &&
          /NETEASE_(AUTHENTICATION|ANONYMOUS|SESSION_EXPIRED|UID_MISMATCH|RISK_CONTROL)/.test(outcome.error_code));
      }
    } finally {
      await step.do("finalize batch", async () => summarizeBatch(this.env, batchId));
    }
  }
}
