import {
  assertCompleteSnapshot,
  planSnapshotSync,
  type CompletePlaylistSnapshot,
  type SyncPlan,
  type SyncState,
} from "./state-machine";
import {
  commitSyncPlan,
  loadSyncState,
  type D1DatabasePort,
  type SyncTrigger,
} from "./repository";

export interface RunSnapshotSyncOptions {
  trigger: SyncTrigger;
  bindingVersion: number;
  runId?: string;
  startedAt?: string;
  state?: SyncState;
}

export interface RunSnapshotSyncResult {
  runId: string;
  plan: SyncPlan;
}

/**
 * Validates before the first database call. Invalid/partial snapshots cause zero D1 writes.
 * A valid transition and its success record are then committed by one transactional D1 batch.
 */
export async function runSnapshotSync(
  db: D1DatabasePort,
  snapshot: CompletePlaylistSnapshot,
  options: RunSnapshotSyncOptions,
): Promise<RunSnapshotSyncResult> {
  assertCompleteSnapshot(snapshot);
  const startedAt = options.startedAt ?? new Date().toISOString();
  const runId = options.runId ?? crypto.randomUUID();
  const state = options.state ?? await loadSyncState(db);
  const plan = planSnapshotSync(snapshot, state);
  await commitSyncPlan(db, plan, {
    runId,
    trigger: options.trigger,
    startedAt,
    bindingVersion: options.bindingVersion,
  });
  return { runId, plan };
}
