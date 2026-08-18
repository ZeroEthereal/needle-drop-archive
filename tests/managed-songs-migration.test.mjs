import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("candidate removal migration preserves rows and promotes old candidates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE songs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artists TEXT NOT NULL,
      album TEXT, cover_url TEXT, netease_url TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE playlist_memberships (
      id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      membership_epoch INTEGER NOT NULL, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, left_at TEXT, is_current INTEGER NOT NULL,
      account_playable INTEGER, last_playable_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE recovery_incidents (
      id TEXT PRIMARY KEY, membership_id TEXT NOT NULL REFERENCES playlist_memberships(id) ON DELETE CASCADE,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      type TEXT NOT NULL, status TEXT NOT NULL, first_observed_date TEXT NOT NULL,
      last_observed_date TEXT NOT NULL, confirmation_streak INTEGER NOT NULL,
      confirmed_at TEXT, recovery_streak INTEGER NOT NULL, last_recovery_date TEXT,
      last_normal_at TEXT, resolved_at TEXT, resolution TEXT,
      suppressed_until_normal INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sync_runs (
      id TEXT PRIMARY KEY, trigger TEXT NOT NULL, status TEXT NOT NULL, phase TEXT,
      observed_at TEXT, shanghai_date TEXT, started_at TEXT NOT NULL, completed_at TEXT,
      current_song_count INTEGER NOT NULL DEFAULT 0, new_count INTEGER NOT NULL DEFAULT 0,
      confirmed_missing_count INTEGER NOT NULL DEFAULT 0,
      confirmed_grey_count INTEGER NOT NULL DEFAULT 0,
      auto_recovered_count INTEGER NOT NULL DEFAULT 0,
      pending_review_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT, error_message TEXT, binding_version INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX sync_runs_started_idx ON sync_runs(started_at);
  `);

  const insertSong = db.prepare(`
    INSERT INTO songs VALUES (?, ?, '["Artist"]', NULL, NULL, ?, ?, ?)
  `);
  const insertMembership = db.prepare(`
    INSERT INTO playlist_memberships VALUES (?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);
  const insertIncident = db.prepare(`
    INSERT INTO recovery_incidents VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, 0, ?, ?
    )
  `);
  const timestamp = "2026-07-18T01:00:00.000Z";
  for (const id of ["normal", "open", "candidate", "resolved"]) {
    insertSong.run(id, id, `https://music.163.com/#/song?id=${id}`, timestamp, timestamp);
  }
  insertMembership.run("normal:1", "normal", timestamp, timestamp, 1, 1, timestamp, timestamp, timestamp);
  insertMembership.run("open:1", "open", timestamp, timestamp, 0, null, timestamp, timestamp, timestamp);
  insertMembership.run("candidate:1", "candidate", timestamp, timestamp, 0, null, timestamp, timestamp, timestamp);
  insertMembership.run("resolved:1", "resolved", timestamp, timestamp, 0, null, timestamp, timestamp, timestamp);

  insertIncident.run("open-grey", "open:1", "open", "grey", "open", "2026-07-17", "2026-07-18", 2, timestamp, timestamp, timestamp, timestamp);
  insertIncident.run("candidate-missing", "candidate:1", "candidate", "missing", "candidate", "2026-07-18", "2026-07-18", 1, null, timestamp, timestamp, timestamp);
  insertIncident.run("resolved-missing", "resolved:1", "resolved", "missing", "resolved", "2026-07-16", "2026-07-17", 2, timestamp, timestamp, timestamp, timestamp);
  db.prepare(`INSERT INTO sync_runs (
    id, trigger, status, started_at, current_song_count, pending_review_count,
    binding_version, created_at, updated_at
  ) VALUES ('run-1', 'manual', 'success', ?, 3, 1, 1, ?, ?)`)
    .run(timestamp, timestamp, timestamp);

  const migration = readFileSync(
    new URL("../drizzle/0002_create_managed_songs.sql", import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
  db.exec(migration);

  const cleanup = readFileSync(
    new URL("../drizzle/0003_remove_legacy_song_state.sql", import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
  db.exec(cleanup);

  const candidateRemoval = readFileSync(
    new URL("../drizzle/0006_remove_anomaly_candidates.sql", import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
  db.exec(candidateRemoval);

  const rows = db.prepare(`
    SELECT song_id, bucket, anomaly_type
    FROM managed_songs ORDER BY song_id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { song_id: "candidate", bucket: "anomaly", anomaly_type: "missing" },
    { song_id: "normal", bucket: "normal", anomaly_type: null },
    { song_id: "open", bucket: "anomaly", anomaly_type: "grey" },
  ]);
  assert.equal(new Set(rows.map((row) => row.song_id)).size, rows.length);
  assert.throws(() => db.prepare("SELECT * FROM playlist_memberships").all());
  assert.throws(() => db.prepare("SELECT * FROM recovery_incidents").all());
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM managed_songs").get().total, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM songs").get().total, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM sync_runs").get().total, 1);
  assert.equal(
    db.prepare("PRAGMA table_info(managed_songs)").all().some((column) => column.name.startsWith("candidate_")),
    false,
  );
  assert.equal(
    db.prepare("PRAGMA table_info(sync_runs)").all().some((column) => column.name === "pending_review_count"),
    false,
  );
});
