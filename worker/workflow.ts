import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "./env";
import { runMusicSync } from "./sync-runner";
import { runPlaylistBinding } from "./binding-runner";

export type MusicSyncParams =
  | { action?: "sync"; source?: "manual" | "scheduled" }
  | { action: "bind_playlist"; bindingId: string };

/**
 * Durable entrypoint used by both the daily Cron Trigger and the manual sync
 * button. A failed upstream response never commits a snapshot; retrying the
 * step is therefore safe and remains idempotent per Shanghai day.
 */
export class MusicSyncWorkflow extends WorkflowEntrypoint<Env, MusicSyncParams> {
  async run(event: WorkflowEvent<MusicSyncParams>, step: WorkflowStep) {
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
