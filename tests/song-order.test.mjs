import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TestD1, setupPlaylists } from "./helpers/d1.mjs";
import { planSnapshotSync } from "../lib/sync/state-machine.ts";
import { commitSyncPlan } from "../lib/sync/repository.ts";
import { commitPlaylistSyncPlan, completeSongEverywhere, listPlaylistSongs, loadPlaylistSyncState } from "../lib/sync/multi-repository.ts";

const song = (id, extra = {}) => ({ id, title: `Song ${id}`, artists: ["Singer"], album: null,
  coverUrl: null, accountPlayable: true, ...extra });
const tracks = (ids) => ids.map((id) => song(id));
const snapshot = (songs, day) => ({ complete: true, declaredTrackCount: songs.length, songs,
  observedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z` });

async function plannedSync(db, playlistId, songs, day) {
  const id = `order-${playlistId}-${day}`;
  db.sqlite.prepare(`INSERT INTO sync_batches (id,trigger,scope,status,binding_version,account_uid,playlist_count)
    VALUES (?,'manual','playlist','running',1,'42',1)`).run(id);
  db.sqlite.prepare(`INSERT INTO sync_playlist_tasks (batch_id,playlist_id,list_order,playlist_name,status,binding_version)
    VALUES (?,?,0,?,'running',1)`).run(id, playlistId, playlistId);
  const plan = planSnapshotSync(snapshot(songs, day), await loadPlaylistSyncState(db, playlistId), true);
  return { id, plan };
}
async function sync(db, playlistId, songs, day) {
  const { id, plan } = await plannedSync(db, playlistId, songs, day);
  await commitPlaylistSyncPlan(db, playlistId, plan, id, 1);
  db.sqlite.prepare("UPDATE sync_batches SET status = 'success' WHERE id = ?").run(id);
  return plan;
}
const ids = async (db, playlist = "A", options = {}) =>
  (await listPlaylistSongs(db, playlist, options)).items.map((item) => item.id);
const positions = (db, playlist = "A") => Object.fromEntries(db.sqlite.prepare(
  "SELECT song_id,playlist_position FROM playlist_song_states WHERE playlist_id = ?"
).all(playlist).map((row) => [row.song_id, row.playlist_position]));

test("first sync and later reorder follow upstream order rather than ID or observation time", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["9", "100", "2"]), 1);
  assert.deepEqual(await ids(db), ["9", "100", "2"]);
  assert.deepEqual(positions(db), { "9": 0, "100": 1, "2": 2 });
  await sync(db, "A", tracks(["2", "9", "100"]), 2);
  assert.deepEqual(await ids(db), ["2", "9", "100"]);
});

test("consecutive missing songs reserve slots across reorders, additions and further disappearances", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["A", "B", "C", "D", "E"]), 1);
  await sync(db, "A", tracks(["A", "D", "E"]), 2);
  assert.deepEqual(await ids(db), ["A", "B", "C", "D", "E"]);
  await sync(db, "A", tracks(["D", "A", "E"]), 3);
  assert.deepEqual(await ids(db), ["D", "B", "C", "A", "E"]);
  assert.deepEqual(positions(db), { A: 3, B: 1, C: 2, D: 0, E: 4 });
  await sync(db, "A", tracks(["F", "E", "A"]), 4);
  assert.deepEqual(await ids(db), ["D", "B", "C", "F", "E", "A"]);
  assert.deepEqual(await ids(db, "A", { state: "playable" }), ["F", "E", "A"]);
});

test("restored membership releases reserved slots and grey/mismatch members follow upstream order", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["A", "B", "C"]), 1);
  await sync(db, "A", tracks(["A", "C"]), 2);
  await sync(db, "A", [song("C", { accountPlayable: false }), song("B", { title: "Wrong" }), song("A")], 3);
  assert.deepEqual(await ids(db), ["C", "B", "A"]);
  assert.deepEqual(positions(db), { A: 2, B: 1, C: 0 });
  assert.equal((await listPlaylistSongs(db, "A")).items[1].state, "mismatch");
});

test("playlist positions remain independent when source status propagates", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["1", "2", "3"]), 1);
  await sync(db, "B", tracks(["3", "1", "2"]), 2);
  const before = positions(db, "B");
  await sync(db, "A", [song("2", { title: "Wrong" }), song("3"), song("1")], 3);
  assert.deepEqual(await ids(db), ["2", "3", "1"]);
  assert.deepEqual(await ids(db, "B"), ["3", "1", "2"]);
  assert.deepEqual(positions(db, "B"), before);
  assert.equal((await listPlaylistSongs(db, "B")).items[2].state, "mismatch");
});

test("filtering and pagination preserve relative playlist order", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["9", "1", "8", "2", "7"]), 1);
  await sync(db, "A", [song("9", { accountPlayable: false }), song("1"), song("8", { accountPlayable: false }),
    song("2"), song("7", { accountPlayable: false })], 2);
  const first = await listPlaylistSongs(db, "A", { state: "grey", limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ["9", "8"]);
  assert.equal(first.nextOffset, 2); assert.equal(first.total, 3);
  assert.deepEqual(await ids(db, "A", { state: "grey", limit: 2, offset: 2 }), ["7"]);
  assert.deepEqual(await ids(db, "A", { query: "Singer", limit: 2, offset: 2 }), ["8", "2"]);
});

test("unknown historical missing positions stay at the end until the songs reappear", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["1", "9", "2"]), 1);
  db.sqlite.exec("UPDATE playlist_song_states SET playlist_position = NULL");
  await sync(db, "A", tracks(["2"]), 2);
  assert.deepEqual(await ids(db), ["2", "9", "1"]);
  assert.deepEqual(positions(db), { "1": null, "9": null, "2": 0 });
  await sync(db, "A", tracks(["9", "2", "1"]), 3);
  assert.deepEqual(await ids(db), ["9", "2", "1"]);
});

test("empty playlists preserve missing slots and completion releases them without blank rows", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["A", "B", "C"]), 1);
  await sync(db, "B", tracks(["C", "B", "A"]), 2);
  await sync(db, "A", [], 3);
  assert.deepEqual(await ids(db), ["A", "B", "C"]);
  assert.deepEqual(positions(db), { A: 0, B: 1, C: 2 });
  assert.equal(await completeSongEverywhere(db, "B", 1, "42"), "completed");
  assert.deepEqual(await ids(db), ["A", "C"]);
  assert.deepEqual(await ids(db, "B"), ["C", "A"]);
  await sync(db, "A", tracks(["C", "D"]), 4);
  assert.deepEqual(await ids(db), ["A", "C", "D"]);
  assert.deepEqual(positions(db), { A: 0, C: 1, D: 2 });
});

test("stale bindings and transactional failures do not commit reordered positions", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  await sync(db, "A", tracks(["1", "2"]), 1);
  const stale = await plannedSync(db, "A", tracks(["2", "1"]), 2);
  db.sqlite.exec("UPDATE instance_config SET binding_version = 2");
  await assert.rejects(commitPlaylistSyncPlan(db, "A", stale.plan, stale.id, 1), /binding changed/);
  assert.deepEqual(positions(db), { "1": 0, "2": 1 });
  db.sqlite.exec("UPDATE instance_config SET binding_version = 1");
  db.sqlite.exec(`CREATE TRIGGER reject_order BEFORE UPDATE OF playlist_position ON playlist_song_states
    WHEN NEW.playlist_position <> OLD.playlist_position BEGIN SELECT RAISE(ABORT,'order rejected'); END`);
  await assert.rejects(commitPlaylistSyncPlan(db, "A", stale.plan, stale.id, 1), /order rejected/);
  assert.deepEqual(await ids(db), ["1", "2"]);
});

test("the compatibility sync entry writes playlist positions", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db);
  const plan = planSnapshotSync(snapshot(tracks(["9", "1", "3"]), 1), await loadPlaylistSyncState(db, "A"), true);
  await commitSyncPlan(db, plan, { runId: "compat", trigger: "manual", startedAt: plan.observedAt, bindingVersion: 1 });
  assert.deepEqual(await ids(db), ["9", "1", "3"]);
});

test("position migration preserves existing relations and rejects invalid positions", (t) => {
  const db = new TestD1({ through: "0010" }); t.after(() => db.close()); setupPlaylists(db);
  db.sqlite.exec(`INSERT INTO songs (id,title,artists,netease_url) VALUES ('1','Original','[]','url');
    INSERT INTO playlist_song_states (playlist_id,song_id,first_seen_at,last_seen_at,last_confirmed_at)
    VALUES ('A','1','2026-10-01','2026-10-01','2026-10-01')`);
  db.sqlite.exec(readFileSync(new URL("../drizzle/0011_playlist_song_position.sql", import.meta.url), "utf8"));
  assert.deepEqual(positions(db), { "1": null });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM songs").get().n, 1);
  assert.throws(() => db.sqlite.exec("UPDATE playlist_song_states SET playlist_position = -1"), /CHECK/);
  assert.throws(() => db.sqlite.exec("UPDATE playlist_song_states SET playlist_position = 1.5"), /CHECK/);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});
