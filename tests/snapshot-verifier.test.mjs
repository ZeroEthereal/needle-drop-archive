import assert from "node:assert/strict";
import test from "node:test";
import { createNeteaseSession, NeteaseClient } from "../lib/netease/index.ts";
import { commitPlaylistSyncPlan, loadPlaylistSyncState } from "../lib/sync/repository.ts";
import { snapshotForStateMachine } from "../lib/sync/snapshot.ts";
import { planSnapshotSync } from "../lib/sync/state-machine.ts";
import { setupPlaylists, TestD1 } from "./helpers/d1.mjs";

const session = createNeteaseSession("MUSIC_U=fake-test-session");
const song = (id, dt) => ({ id, name: `Song ${id}`, ar: [{ id: 1, name: "Artist" }], dt });
const playable = (id) => ({ id, code: 200, url: "https://example.com/audio" });
const observe = (opts = {}) => {
  const { ids = [2, 3], trackCount = ids.length, details = [song(2, 180001), song(3, 180002)],
    playback = [{ id: 2, code: 404, url: null }, playable(3)], cloudCount = ids.length } = opts;
  const calls = [];
  const client = new NeteaseClient({ retryCount: 0, fetch: async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const replies = {
      "/api/nuser/account/get": { profile: { userId: 42 } },
      "/api/v6/playlist/detail": { playlist: { id: 1000, userId: 42, trackCount,
        trackIds: ids.map((id) => ({ id })) } },
      "/api/v1/cloud/get": { count: cloudCount, hasMore: false, data: ids.map((id) => ({ songId: id })) },
      "/api/v3/song/detail": { songs: details },
      "/api/v1/cloud/get/byids": { data: [] },
      "/api/song/enhance/player/url": { data: playback },
    };
    assert.ok(replies[path], `Unexpected request: ${path}`);
    return Response.json({ code: 200, ...replies[path] });
  } });
  return { client, calls };
};

function seededDb(t) {
  const db = new TestD1();
  t.after(() => db.close());
  setupPlaylists(db, ["1000"]);
  for (const id of [1, 2, 3]) {
    db.sqlite.prepare(`INSERT INTO songs (id,title,artists,netease_url,duration_ms,baseline_duration_ms)
      VALUES (?,?,'["Artist"]','url',180001,180001)`).run(String(id), `Song ${id}`);
    db.sqlite.prepare(`INSERT INTO playlist_song_states (playlist_id,song_id,first_seen_at,last_seen_at,last_confirmed_at)
      VALUES ('1000',?,'2026-08-16','2026-08-16','2026-08-16')`).run(String(id));
  }
  db.sqlite.exec(`INSERT INTO sync_batches (id,trigger,scope,status,binding_version,account_uid,playlist_count)
    VALUES ('batch','manual','playlist','running',1,'42',1);
    INSERT INTO sync_playlist_tasks (batch_id,playlist_id,list_order,playlist_name,status,binding_version)
    VALUES ('batch','1000',0,'Playlist','running',1)`);
  return db;
}

async function sync(db, client) {
  const state = await loadPlaylistSyncState(db, "1000");
  const account = await client.getAccountSnapshot(session, { playlistId: "1000", expectedUserId: "42" });
  const plan = planSnapshotSync(snapshotForStateMachine(account), state, true);
  await commitPlaylistSyncPlan(db, "1000", plan, "batch", 1);
}

test("one complete snapshot commits missing, grey and mismatch without further upstream reads", async (t) => {
  const db = seededDb(t);
  const { client, calls } = observe();
  await sync(db, client);
  assert.deepEqual(calls, ["/api/nuser/account/get", "/api/v6/playlist/detail",
    "/api/v3/song/detail", "/api/song/enhance/player/url"]);
  const states = db.sqlite.prepare("SELECT anomaly_type FROM playlist_song_states ORDER BY song_id").all();
  assert.deepEqual(states.map((row) => row.anomaly_type), ["missing", "grey", "mismatch"]);
  assert.equal(db.sqlite.prepare("SELECT status FROM sync_playlist_tasks").get().status, "success");
});

for (const [label, options] of [["members", { trackCount: 3 }], ["metadata", { details: [song(3, 180002)] }],
  ["playback", { playback: [playable(3)] }]]) {
  test(`incomplete snapshot ${label} leaves all prior song states untouched`, async (t) => {
    const db = seededDb(t);
    const { client } = observe(options);
    await assert.rejects(sync(db, client), (error) => error.kind === "incomplete_response");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_song_states WHERE bucket = 'normal'").get().count, 3);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM songs WHERE observed_duration_ms IS NOT NULL").get().count, 0);
  });
}

test("cloud snapshot checks pagination and reads details and playback once", async () => {
  const { client, calls } = observe();
  const cloud = await client.getCloudAccountSnapshot(session, { expectedUserId: "42" });
  assert.deepEqual(snapshotForStateMachine(cloud).songs.map((item) => item.durationMs), [180001, 180002]);
  assert.deepEqual(calls, ["/api/nuser/account/get", "/api/v1/cloud/get",
    "/api/v3/song/detail", "/api/song/enhance/player/url"]);
  await assert.rejects(observe({ cloudCount: 3 }).client.getCloudAccountSnapshot(session),
    (error) => error.kind === "incomplete_response");
});
