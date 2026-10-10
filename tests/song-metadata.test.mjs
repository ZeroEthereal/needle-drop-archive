import assert from "node:assert/strict";
import test from "node:test";
import { NeteaseClient, createNeteaseSession } from "../lib/netease/index.ts";
import { encodeSongUpserts, stagedSongMetadata } from "../lib/sync/song-storage.ts";
import { planSnapshotSync } from "../lib/sync/state-machine.ts";

const rawSong = (name) => ({ id: 123, name, ar: [{ id: 1, name: "Singer" }], al: { id: 2, name: "Album" } });
const session = createNeteaseSession("MUSIC_U=fake-test-session");
function clientFor({ standard = [], cloud = [], embedded = [] } = {}) {
  const calls = [];
  const client = new NeteaseClient({ retryCount: 0, fetch: async (url) => {
    const path = new URL(url).pathname; calls.push(path);
    const body = path === "/api/v3/song/detail" ? { code: 200, songs: standard } :
      path === "/api/v1/cloud/get/byids" ? { code: 200, data: cloud } :
      { code: 200, playlist: { id: 1000, userId: 42, name: "Playlist", creator: { userId: 42, nickname: "Owner" },
        trackCount: 1, trackIds: [{ id: 123 }], tracks: embedded } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  } });
  return { client, calls };
}

test("standard song detail is preferred and preserves identity whitespace", async () => {
  const { client, calls } = clientFor({ standard: [rawSong("Standard ")] });
  const result = await client.getSongMetadata(["123"], session, "1000");
  assert.equal(result.songs[0].song.title, "Standard ");
  assert.deepEqual(calls, ["/api/v3/song/detail"]);
});

test("cloud details supply metadata when standard detail is missing", async () => {
  const { client, calls } = clientFor({ cloud: [{ songId: 123, songName: "Cloud", artist: "Singer", album: "Album" }] });
  const result = await client.getSongMetadata(["123"], session, "1000");
  assert.equal(result.songs[0].id, "123"); assert.equal(result.songs[0].song.title, "Cloud");
  assert.equal(result.songs[0].inCloud, true);
  assert.deepEqual(calls, ["/api/v3/song/detail", "/api/v1/cloud/get/byids"]);
});

test("metadata recheck fetches fresh playlist embedded detail instead of reusing the first snapshot", async () => {
  const { client, calls } = clientFor({ embedded: [rawSong("Fresh embedded")] });
  const result = await client.getSongMetadata(["123"], session, "1000");
  assert.equal(result.songs[0].song.title, "Fresh embedded");
  assert.deepEqual(calls, ["/api/v3/song/detail", "/api/v1/cloud/get/byids", "/api/v6/playlist/detail"]);
});

test("unresolved metadata cannot fabricate a mismatch or overwrite stored identity", async () => {
  const { client } = clientFor();
  await assert.rejects(client.getSongMetadata(["123"], session, "1000"), (error) => error.kind === "incomplete_response");
});

test("multiple staged baselines share the first identity and retain preceding mismatch evidence through grey", () => {
  const input = (title, playable = true) => ({ complete: true, observedAt: "2026-10-01T00:00:00Z",
    declaredTrackCount: 1, songs: [{ id: "123", title, artists: ["Singer"], album: null,
      coverUrl: null, accountPlayable: playable }] });
  const first = planSnapshotSync(input("Original"), { managedSongs: [] }, false);
  const originals = stagedSongMetadata([], [encodeSongUpserts(first.songUpserts)]);
  const wrong = planSnapshotSync(input("Wrong"), { managedSongs: [], songs: originals }, false);
  assert.equal(wrong.managedSongUpserts[0].anomalyType, "mismatch");
  const shared = stagedSongMetadata([], [encodeSongUpserts(first.songUpserts), encodeSongUpserts(wrong.songUpserts)]);
  const grey = planSnapshotSync(input("Do not record", false), { managedSongs: [], songs: shared }, false);
  assert.equal(grey.songUpserts[0].title, "Original"); assert.equal(grey.songUpserts[0].observedTitle, "Wrong");
  assert.equal(grey.managedSongUpserts[0].anomalyType, "grey");
});
