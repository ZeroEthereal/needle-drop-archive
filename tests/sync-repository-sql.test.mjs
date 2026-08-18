import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  commitSyncPlan,
  BindingChangedError,
  completeManagedSong,
  getSyncOverview,
  listCurrentLikes,
  loadSyncState,
  startSyncRun,
  SyncAlreadyRunningError,
  updateSyncRunPhase,
} from "../lib/sync/repository.ts";
import { planSnapshotSync } from "../lib/sync/state-machine.ts";

class TestStatement {
  constructor(database, sql) {
    this.statement = database.prepare(sql);
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async all() {
    return { success: true, results: this.statement.all(...this.values) };
  }

  async first(columnName) {
    const row = this.statement.get(...this.values) ?? null;
    return row && columnName ? row[columnName] : row;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  executeInBatch() {
    return this.statement.columns().length > 0 ? this.all() : this.run();
  }
}

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(`
      CREATE TABLE songs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artists TEXT NOT NULL,
        album TEXT, cover_url TEXT, netease_url TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE managed_songs (
        song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
        bucket TEXT NOT NULL, anomaly_type TEXT, first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, last_playable_at TEXT, confirmed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY, trigger TEXT NOT NULL, status TEXT NOT NULL, phase TEXT,
        observed_at TEXT, shanghai_date TEXT, started_at TEXT NOT NULL, completed_at TEXT,
        current_song_count INTEGER NOT NULL DEFAULT 0, new_count INTEGER NOT NULL DEFAULT 0,
        confirmed_missing_count INTEGER NOT NULL DEFAULT 0,
        confirmed_grey_count INTEGER NOT NULL DEFAULT 0,
        auto_recovered_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, error_message TEXT, binding_version INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE instance_config (
        id TEXT PRIMARY KEY, binding_version INTEGER NOT NULL, status TEXT NOT NULL
      );
      INSERT INTO instance_config VALUES ('primary', 1, 'ready');
    `);
  }

  prepare(sql) {
    return new TestStatement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.executeInBatch());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const song = (id, playable = true) => ({
  id,
  title: `Song ${id}`,
  artists: ["Artist"],
  album: "Album",
  coverUrl: null,
  accountPlayable: playable,
});

function snapshot(observedAt, songs) {
  return { observedAt, declaredTrackCount: songs.length, complete: true, songs };
}

async function run(db, runId, observedAt, songs) {
  const state = await loadSyncState(db);
  const plan = planSnapshotSync(snapshot(observedAt, songs), state);
  await commitSyncPlan(db, plan, { runId, trigger: "manual", startedAt: observedAt, bindingVersion: 1 });
  return plan;
}

test("bulk JSON upserts and state reload use the single managed song table", async () => {
  const db = new TestD1();
  await run(db, "run-1", "2026-07-16T01:00:00Z", [song("1"), song("2")]);

  let state = await loadSyncState(db);
  assert.equal(state.managedSongs.length, 2);
  assert.equal(state.managedSongs.every((row) => row.bucket === "normal"), true);

  await run(db, "run-2", "2026-07-17T01:00:00Z", [song("2")]);
  state = await loadSyncState(db);
  const missing = state.managedSongs.find((row) => row.songId === "1");
  assert.equal(missing.bucket, "anomaly");
  assert.equal(missing.anomalyType, "missing");
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM sync_runs").get().count,
    2,
  );
});

test("completing an anomaly deletes only that song and keeps unrelated songs", async () => {
  const db = new TestD1();
  await run(db, "run-1", "2026-07-16T01:00:00Z", [song("1"), song("2")]);
  await run(db, "run-2", "2026-07-17T01:00:00Z", [song("2")]);
  await run(db, "run-3", "2026-07-18T01:00:00Z", [song("2")]);

  assert.equal(await completeManagedSong(db, "1"), "completed");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM songs WHERE id = '1'").get().count, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM songs WHERE id = '2'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM managed_songs").get().count, 1);
});

test("a stale completion request cannot delete a song already restored to normal", async () => {
  const db = new TestD1();
  await run(db, "run-1", "2026-07-16T01:00:00Z", [song("1"), song("2")]);
  await run(db, "run-2", "2026-07-17T01:00:00Z", [song("1", false), song("2")]);
  await run(db, "run-3", "2026-07-18T01:00:00Z", [song("1", false), song("2")]);
  await run(db, "run-4", "2026-07-19T01:00:00Z", [song("1"), song("2")]);

  assert.equal(await completeManagedSong(db, "1"), "normal");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM songs WHERE id = '1'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT bucket FROM managed_songs WHERE song_id = '1'").get().bucket, "normal");
});

test("likes and overview expose a duplicate-free total that equals all three buckets", async () => {
  const db = new TestD1();
  await run(db, "run-1", "2026-07-16T01:00:00Z", [song("1"), song("2"), song("3")]);
  await run(db, "run-2", "2026-07-17T01:00:00Z", [song("1"), song("2", false)]);
  await run(db, "run-3", "2026-07-18T01:00:00Z", [song("1"), song("2", false)]);

  const likes = await listCurrentLikes(db, { limit: 100 });
  const overview = await getSyncOverview(db);
  assert.equal(likes.total, 3);
  assert.deepEqual(new Set(likes.items.map((item) => item.state)), new Set(["playable", "grey", "missing"]));
  assert.equal(
    overview.totalSongCount,
    overview.normalCount + overview.greyCount + overview.missingCount,
  );
});

test("sync run phases are visible and a concurrent fresh run is rejected", async () => {
  const db = new TestD1();
  await startSyncRun(db, {
    runId: "running-1",
    trigger: "manual",
    startedAt: "2026-07-16T01:00:00.000Z",
    bindingVersion: 1,
  });
  await updateSyncRunPhase(db, "running-1", "fetch_snapshot");

  const running = db.sqlite.prepare("SELECT status, phase FROM sync_runs WHERE id = 'running-1'").get();
  assert.equal(running.status, "running");
  assert.equal(running.phase, "fetch_snapshot");

  await assert.rejects(
    startSyncRun(db, {
      runId: "running-2",
      trigger: "scheduled",
      startedAt: "2026-07-16T01:05:00.000Z",
      bindingVersion: 1,
    }),
    SyncAlreadyRunningError,
  );
});

test("a sync captured under an old binding version cannot commit songs or success", async () => {
  const db = new TestD1();
  const state = await loadSyncState(db);
  const plan = planSnapshotSync(snapshot("2026-07-16T01:00:00Z", [song("old-playlist-song")]), state);
  db.sqlite.prepare("UPDATE instance_config SET binding_version = 2").run();

  await assert.rejects(
    commitSyncPlan(db, plan, {
      runId: "stale-run",
      trigger: "scheduled",
      startedAt: "2026-07-16T01:00:00Z",
      bindingVersion: 1,
    }),
    BindingChangedError,
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM songs").get().count, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM sync_runs WHERE status = 'success'").get().count, 0);
});
