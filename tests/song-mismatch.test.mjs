import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TestD1, setupPlaylists } from "./helpers/d1.mjs";
import { planSnapshotSync } from "../lib/sync/state-machine.ts";
import { encodeSongUpserts, propagateSourceSql } from "../lib/sync/song-storage.ts";
import { commitPlaylistSyncPlan, completeSongEverywhere, listMultiRecovery,
  listMonitoredPlaylists, listPlaylistSongs, loadPlaylistSyncState } from "../lib/sync/multi-repository.ts";

const song = (changes = {}) => ({ id: "123", title: "Original", artists: ["Artist A", "Artist B"],
  album: "Album", coverUrl: "https://example.com/original.jpg", accountPlayable: true, ...changes });

async function sync(db, playlistId, songs, day) {
  const observedAt = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const batchId = `${playlistId}-${day}`;
  db.sqlite.prepare(`INSERT INTO sync_batches (id, trigger, scope, status, binding_version, account_uid, playlist_count)
    VALUES (?, 'manual', 'playlist', 'running', 1, '42', 1)`).run(batchId);
  db.sqlite.prepare(`INSERT INTO sync_playlist_tasks (batch_id, playlist_id, list_order, playlist_name, status, binding_version)
    VALUES (?, ?, 0, ?, 'running', 1)`).run(batchId, playlistId, playlistId);
  const state = await loadPlaylistSyncState(db, playlistId);
  const plan = planSnapshotSync({ observedAt, songs, declaredTrackCount: songs.length, complete: true }, state, true);
  await commitPlaylistSyncPlan(db, playlistId, plan, batchId, 1);
  db.sqlite.prepare("UPDATE sync_batches SET status = 'success' WHERE id = ?").run(batchId);
  return plan;
}
const stored = (db) => db.sqlite.prepare("SELECT * FROM songs WHERE id = '123'").get();
const status = (db, playlist = "A") => db.sqlite.prepare("SELECT * FROM playlist_song_states WHERE playlist_id = ? AND song_id = '123'").get(playlist);

test("first insertion has a fixed original identity and NULL mismatch fields", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1);
  assert.equal(stored(db).observed_title, null);
  assert.equal(stored(db).observed_artists, null);
  assert.equal(status(db).bucket, "normal");
});

for (const [label, changes] of [
  ["title only", { title: "Changed" }], ["artist only", { artists: ["Other"] }],
  ["title whitespace", { title: "Original " }], ["artist whitespace", { artists: ["Artist A ", "Artist B"] }],
  ["artist order", { artists: ["Artist B", "Artist A"] }],
]) test(`exact mismatch detection: ${label}`, async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1);
  const plan = await sync(db, "A", [song({ ...changes, album: "Wrong album", coverUrl: "wrong" })], 2);
  assert.equal(status(db).anomaly_type, "mismatch");
  assert.equal(plan.result.confirmedMismatchCount, 1);
  assert.equal(stored(db).title, "Original");
  assert.deepEqual(JSON.parse(stored(db).artists), ["Artist A", "Artist B"]);
  assert.equal(stored(db).observed_title, changes.title ?? "Original");
  assert.deepEqual(JSON.parse(stored(db).observed_artists), changes.artists ?? song().artists);
  assert.equal(stored(db).album, "Album");
  assert.equal(stored(db).cover_url, song().coverUrl);
  assert.equal(status(db).last_playable_at, "2026-10-01T00:00:00.000Z");
});

test("latest wrong identity replaces the observation, and stable mismatch does not reconfirm", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1);
  await sync(db, "A", [song({ title: "Wrong one" })], 2);
  const turn = await sync(db, "A", [song({ title: "Wrong two" })], 3);
  assert.equal(stored(db).observed_title, "Wrong two");
  assert.equal(stored(db).title, "Original");
  assert.equal(turn.result.confirmedMismatchCount, 0);
  assert.equal(status(db).confirmed_at, "2026-10-02T00:00:00.000Z");
});

test("album and cover alone update normally without mismatch", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1);
  await sync(db, "A", [song({ album: "New album", coverUrl: "new-cover" })], 2);
  assert.equal(status(db).bucket, "normal"); assert.equal(stored(db).observed_title, null);
  assert.equal(stored(db).album, "New album"); assert.equal(stored(db).cover_url, "new-cover");
});

test("grey and missing retain prior mismatch evidence; normal recovery clears it", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1);
  await sync(db, "A", [song({ title: "Wrong" })], 2);
  await sync(db, "A", [song({ title: "Do not store", accountPlayable: false })], 3);
  assert.equal(status(db).anomaly_type, "grey"); assert.equal(stored(db).observed_title, "Wrong");
  await sync(db, "A", [], 4);
  assert.equal(status(db).anomaly_type, "missing"); assert.equal(stored(db).observed_title, "Wrong");
  await sync(db, "A", [song({ title: "Wrong again" })], 5);
  assert.equal(status(db).anomaly_type, "mismatch");
  assert.equal(status(db).last_playable_at, "2026-10-01T00:00:00.000Z");
  await sync(db, "A", [song({ accountPlayable: false })], 6);
  assert.equal(status(db).anomaly_type, "grey"); assert.equal(stored(db).observed_title, "Wrong again");
  const recovery = await sync(db, "A", [song()], 7);
  assert.equal(status(db).bucket, "normal"); assert.equal(stored(db).observed_title, null);
  assert.equal(stored(db).observed_artists, null);
  assert.equal(status(db).last_playable_at, "2026-10-07T00:00:00.000Z");
  assert.equal(recovery.result.autoRecoveredCount, 1);
});

test("first insertion when grey does not claim any last-normal time or new identity", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song({ accountPlayable: false })], 1);
  assert.equal(status(db).last_playable_at, null); assert.equal(stored(db).observed_title, null);
});

test("source states propagate across playlists while last-seen and missing membership stay independent", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1); await sync(db, "B", [song()], 2);
  const seen = status(db, "B").last_seen_at;
  await sync(db, "A", [song({ title: "Wrong" })], 3);
  assert.equal(status(db, "B").anomaly_type, "mismatch"); assert.equal(status(db, "B").last_seen_at, seen);
  await sync(db, "B", [], 4);
  await sync(db, "A", [song({ accountPlayable: false })], 5);
  assert.equal(status(db).anomaly_type, "grey"); assert.equal(status(db, "B").anomaly_type, "missing");
  assert.equal(stored(db).observed_title, "Wrong");
  await sync(db, "A", [song()], 6);
  assert.equal(status(db).bucket, "normal"); assert.equal(status(db, "B").anomaly_type, "missing");
  await sync(db, "B", [song()], 7); assert.equal(status(db, "B").bucket, "normal");
});

test("newly monitored playlists reuse existing identity instead of accepting wrong identity", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1); await sync(db, "B", [song({ title: "Wrong" })], 2);
  assert.equal(stored(db).title, "Original"); assert.equal(status(db).anomaly_type, "mismatch");
  assert.equal(status(db, "B").anomaly_type, "mismatch"); assert.equal(status(db, "B").last_playable_at, null);
});

test("older staged source observations cannot manufacture a normal time for a new anomalous membership", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  const first = await sync(db, "A", [song()], 1);
  await sync(db, "B", [song({ title: "Wrong" })], 2);
  const time = first.observedAt;
  await db.prepare(propagateSourceSql("true")).bind(encodeSongUpserts(first.songUpserts),
    time, time, time, time, time).run();
  assert.equal(status(db).anomaly_type, "mismatch");
  assert.equal(status(db, "B").anomaly_type, "mismatch");
  assert.equal(status(db, "B").last_playable_at, null);
});

test("recovery priority, counters, original-only search, and server-side filtered pagination", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song(), song({ id: "456" }), song({ id: "789" })], 1);
  await sync(db, "B", [song()], 2); await sync(db, "B", [], 3);
  await sync(db, "A", [song({ title: "WrongOnly" }), song({ id: "456", title: "WrongOnly" }), song({ id: "789" })], 4);
  const page = await listMultiRecovery(db, { type: "mismatch" });
  assert.equal(page.total, 2); assert.equal(page.items.find((s) => s.songId === "123").type, "missing");
  assert.equal(page.items.find((s) => s.songId === "123").observedTitle, null);
  assert.equal(page.items.find((s) => s.songId === "456").observedTitle, "WrongOnly");
  assert.equal((await listMultiRecovery(db, { query: "WrongOnly" })).total, 0);
  assert.equal((await listPlaylistSongs(db, "A", { query: "WrongOnly" })).total, 0);
  const first = await listPlaylistSongs(db, "A", { state: "mismatch", limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.items.length, 1); assert.equal(first.nextOffset, 1);
  const second = await listPlaylistSongs(db, "A", { state: "mismatch", limit: 1, offset: first.nextOffset });
  assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextOffset, null);
  const overview = (await listMonitoredPlaylists(db)).find((p) => p.id === "A");
  assert.equal(overview.mismatchCount, 2);
  assert.equal(overview.totalSongCount, overview.normalCount + overview.greyCount + overview.missingCount + overview.mismatchCount);
});

test("completion deletes every reference and identity; subsequent insertion establishes a fresh baseline", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1); await sync(db, "B", [song()], 2); await sync(db, "A", [], 3);
  assert.equal(status(db, "B").bucket, "normal");
  assert.equal(await completeSongEverywhere(db, "123", 1, "42"), "completed");
  assert.equal(stored(db), undefined); assert.equal(status(db), undefined); assert.equal(status(db, "B"), undefined);
  await sync(db, "B", [song({ title: "New baseline" })], 4);
  assert.equal(stored(db).title, "New baseline"); assert.equal(stored(db).observed_title, null);
  assert.equal(status(db, "B").bucket, "normal");
});

test("completion is blocked while syncing or when the anomaly has already recovered", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1);
  assert.equal(await completeSongEverywhere(db, "123", 1, "42"), "normal");
  await sync(db, "A", [song({ title: "Wrong" })], 2);
  db.sqlite.exec("UPDATE sync_batches SET status = 'running'");
  assert.equal(await completeSongEverywhere(db, "123", 1, "42"), "sync_in_progress");
  assert.equal(stored(db).title, "Original");
});

test("stale binding and transactional failures cannot leave partial metadata or propagated states", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", [song()], 1); await sync(db, "B", [song()], 2);
  db.sqlite.exec("UPDATE instance_config SET binding_version = 2");
  await assert.rejects(sync(db, "A", [song({ title: "Wrong" })], 3), /binding changed/i);
  assert.equal(stored(db).observed_title, null); assert.equal(status(db, "B").bucket, "normal");
  db.sqlite.exec("UPDATE instance_config SET binding_version = 1");
  db.sqlite.exec("CREATE TRIGGER reject_source BEFORE UPDATE ON playlist_song_states WHEN NEW.anomaly_type = 'mismatch' BEGIN SELECT RAISE(ABORT, 'reject source'); END");
  await assert.rejects(sync(db, "A", [song({ title: "Wrong" })], 4), /reject source/);
  assert.equal(stored(db).observed_title, null); assert.equal(status(db).bucket, "normal");
});

test("migration preserves pre-existing records and permits mismatch with the same foreign-key cleanup", async (t) => {
  const db = new TestD1({ through: "0008" }); t.after(() => db.close()); setupPlaylists(db);
  db.sqlite.exec(`INSERT INTO songs (id,title,artists,netease_url) VALUES ('123','Old title','["Old artist"]','url');
    INSERT INTO playlist_song_states (playlist_id,song_id,first_seen_at,last_seen_at,last_confirmed_at)
    VALUES ('A','123','old','old','old')`);
  db.sqlite.exec(readFileSync(new URL("../drizzle/0009_song_mismatch.sql", import.meta.url), "utf8"));
  assert.equal(stored(db).title, "Old title"); assert.equal(stored(db).observed_title, null);
  db.sqlite.exec("UPDATE playlist_song_states SET bucket='anomaly',anomaly_type='mismatch',confirmed_at='now'");
  db.sqlite.exec("DELETE FROM monitored_playlists WHERE id='A'");
  assert.equal(status(db), undefined); assert.ok(stored(db));
  db.sqlite.exec("DELETE FROM songs WHERE NOT EXISTS (SELECT 1 FROM playlist_song_states WHERE song_id=songs.id)");
  assert.equal(stored(db), undefined); assert.equal(db.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
});
