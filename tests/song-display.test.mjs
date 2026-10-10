import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizeSongTextList, songSubtitle, formatSongDuration } from "../lib/song-display.ts";
import { planSnapshotSync } from "../lib/sync/state-machine.ts";
import { decodeSongUpserts, encodeSongUpserts } from "../lib/sync/song-storage.ts";
import { commitPlaylistSyncPlan, listMultiRecovery, listPlaylistSongs, loadPlaylistSyncState } from "../lib/sync/multi-repository.ts";
import { TestD1, setupPlaylists } from "./helpers/d1.mjs";

const song = (extra = {}) => ({ id: "123", title: "Original", artists: ["Singer"], album: "Album",
  coverUrl: null, accountPlayable: true, aliases: ["Alias", "Alias two"], translations: ["Translation"],
  durationMs: 326999, ...extra });

async function sync(db, songs, day) {
  const id = `display-${day}`;
  db.sqlite.prepare(`INSERT INTO sync_batches (id, trigger, scope, status, binding_version, account_uid, playlist_count)
    VALUES (?, 'manual', 'playlist', 'running', 1, '42', 1)`).run(id);
  db.sqlite.prepare(`INSERT INTO sync_playlist_tasks (batch_id, playlist_id, list_order, playlist_name, status, binding_version)
    VALUES (?, 'A', 0, 'A', 'running', 1)`).run(id);
  const plan = planSnapshotSync({ complete: true, declaredTrackCount: songs.length, songs,
    observedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z` }, await loadPlaylistSyncState(db, "A"), true);
  await commitPlaylistSyncPlan(db, "A", plan, id, 1);
  db.sqlite.prepare("UPDATE sync_batches SET status = 'success' WHERE id = ?").run(id);
  return plan;
}

test("subtitle uses all distinct aliases before translations and preserves source wording", () => {
  assert.deepEqual(normalizeSongTextList(["Alias ", "Alias ", "Alias two", "", "  ", null]), ["Alias ", "Alias two"]);
  assert.equal(songSubtitle({ aliases: ["Alias", "Alias", "Two"], translations: ["Hidden"] }), "Alias / Two");
  assert.equal(songSubtitle({ aliases: [], translations: ["Translated", "Translated", "Two"] }), "Translated / Two");
  assert.equal(songSubtitle({ aliases: [" "], translations: ["Translated"] }), "Translated");
  assert.equal(songSubtitle({}), "");
});

test("duration floors milliseconds, pads seconds, allows long tracks and marks missing data", () => {
  for (const [value, expected] of [[326999,"5:26"], [59999,"0:59"], [60000,"1:00"], [3600000,"60:00"],
    [6000000,"100:00"], [1,"0:00"], [0,"—"], [-1,"—"], [null,"—"], [undefined,"—"], [NaN,"—"], [Infinity,"—"]])
    assert.equal(formatSongDuration(value), expected);
});

test("display metadata follows the original through mismatch, grey and missing, then updates on recovery", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db, ["A"]);
  await sync(db, [song()], 1);
  const wrong = { title: "Wrong", aliases: ["Wrong alias"], translations: ["Wrong translation"], durationMs: 120000 };
  await sync(db, [song(wrong)], 2);
  let recovery = (await listMultiRecovery(db)).items[0];
  assert.deepEqual(recovery.aliases, ["Alias", "Alias two"]);
  assert.deepEqual(recovery.translations, ["Translation"]);
  assert.equal(recovery.durationMs, 326999);
  assert.equal(recovery.observedTitle, "Wrong");
  await sync(db, [song({ ...wrong, accountPlayable: false })], 3);
  await sync(db, [song({ id: "456" })], 4);
  recovery = (await listMultiRecovery(db)).items[0];
  assert.equal(recovery.type, "missing"); assert.equal(recovery.durationMs, 326999);
  assert.deepEqual(recovery.aliases, ["Alias", "Alias two"]);
  const plan = await sync(db, [song({ aliases: [], translations: ["Restored translation"], durationMs: 360000 })], 5);
  assert.equal(plan.result.autoRecoveredCount, 1);
  const row = (await listPlaylistSongs(db, "A", { query: "Original" })).items.find((s) => s.id === "123");
  assert.equal(row.state, "playable"); assert.deepEqual(row.aliases, []);
  assert.equal(row.durationMs, 360000); assert.equal(songSubtitle(row), "Restored translation");
  assert.equal((await listPlaylistSongs(db, "A", { query: "Restored translation" })).total, 0);
});

test("first abnormal insertion can save metadata; existing missing fields never adopt mismatched data", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db, ["A"]);
  await sync(db, [song({ accountPlayable: false })], 1);
  assert.equal((await listPlaylistSongs(db, "A")).items[0].durationMs, 326999);
  db.sqlite.exec("UPDATE songs SET aliases = NULL, translations = NULL, duration_ms = NULL");
  await sync(db, [song({ title: "Wrong" })], 2);
  const row = (await listMultiRecovery(db)).items[0];
  assert.equal(row.aliases, null); assert.equal(row.translations, null); assert.equal(row.durationMs, null);
});

test("normal metadata-only changes do not produce mismatch and missing fields clear old display values", async (t) => {
  const db = new TestD1(); t.after(() => db.close()); setupPlaylists(db, ["A"]);
  await sync(db, [song()], 1);
  const plan = await sync(db, [song({ aliases: [], translations: [], durationMs: null })], 2);
  assert.equal(plan.result.confirmedMismatchCount, 0);
  const row = (await listPlaylistSongs(db, "A")).items[0];
  assert.equal(row.state, "playable"); assert.equal(songSubtitle(row), ""); assert.equal(row.durationMs, null);
});

test("staged metadata round-trips arrays and supports older payloads with absent optional fields", () => {
  const plan = planSnapshotSync({ complete: true, declaredTrackCount: 1, songs: [song()],
    observedAt: "2026-10-01T00:00:00Z" }, { managedSongs: [] }, false);
  assert.deepEqual(decodeSongUpserts(encodeSongUpserts(plan.songUpserts)), plan.songUpserts);
  const old = JSON.parse(encodeSongUpserts(plan.songUpserts));
  delete old[0].aliases; delete old[0].translations; delete old[0].durationMs;
  assert.equal(decodeSongUpserts(JSON.stringify(old))[0].durationMs, null);
});

test("migration leaves originals, references and prior mismatch evidence intact with NULL display metadata", (t) => {
  const db = new TestD1({ through: "0009" }); t.after(() => db.close()); setupPlaylists(db, ["A"]);
  db.sqlite.exec(`INSERT INTO songs (id,title,artists,netease_url,observed_title,observed_artists)
    VALUES ('123','Original','["Singer"]','https://music.163.com/song?id=123','Wrong','["Other"]');
    INSERT INTO playlist_song_states (playlist_id,song_id,bucket,anomaly_type,first_seen_at,last_seen_at,last_confirmed_at,confirmed_at)
    VALUES ('A','123','anomaly','mismatch','2026-10-01','2026-10-01','2026-10-01','2026-10-01')`);
  db.sqlite.exec(readFileSync(new URL("../drizzle/0010_song_display_metadata.sql", import.meta.url), "utf8"));
  const row = db.sqlite.prepare("SELECT * FROM songs").get();
  assert.equal(row.title, "Original"); assert.equal(row.observed_title, "Wrong");
  assert.equal(row.aliases, null); assert.equal(row.translations, null); assert.equal(row.duration_ms, null);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM playlist_song_states").get().n, 1);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});
