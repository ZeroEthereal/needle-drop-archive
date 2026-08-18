import assert from "node:assert/strict";
import test from "node:test";

import { createNeteaseSession, NeteaseError } from "../lib/netease/index.ts";
import { verifySnapshotAnomalies } from "../worker/snapshot-verifier.ts";

const session = createNeteaseSession("MUSIC_U=fake-test-session");

const playlist = (trackIds) => ({
  id: "1000",
  name: "Test Playlist",
  userId: "42",
  ownerName: "Owner",
  coverUrl: null,
  privacy: 0,
  trackCount: trackIds.length,
  cloudTrackCount: 0,
  trackIds,
  embeddedTracks: [],
  updateTime: null,
});

const account = (songs) => ({
  capturedAt: "2026-08-17T01:00:00.000Z",
  userId: "42",
  playlist: playlist(songs.map((song) => song.id)),
  trackIds: songs.map((song) => song.id),
  cloudSongs: [],
  songs: songs.map((song) => ({
    id: song.id,
    song: {
      id: song.id,
      title: `Song ${song.id}`,
      artists: [{ id: "artist", name: "Artist" }],
      album: { id: "album", name: "Album", coverUrl: null },
      durationMs: null,
      neteaseUrl: `https://music.163.com/#/song?id=${song.id}`,
    },
    playable: song.playable,
    playbackCode: song.playable ? 200 : 404,
    playbackReason: song.playable ? "playable" : "no_url",
    inCloud: false,
  })),
  warnings: [],
});

const managed = (songId, bucket = "normal", anomalyType = null) => ({
  songId,
  bucket,
  anomalyType,
  firstSeenAt: "2026-08-16T01:00:00.000Z",
  lastSeenAt: "2026-08-16T01:00:00.000Z",
  lastPlayableAt: "2026-08-16T01:00:00.000Z",
  confirmedAt: bucket === "anomaly" ? "2026-08-16T01:00:00.000Z" : null,
  createdAt: "2026-08-16T01:00:00.000Z",
  updatedAt: "2026-08-16T01:00:00.000Z",
});

function fakeClient({ secondTrackIds = [], availability = [], playlistError, playbackError } = {}) {
  return {
    playlistCalls: 0,
    playbackCalls: 0,
    async getPlaylistDetail() {
      this.playlistCalls += 1;
      if (playlistError) throw playlistError;
      return playlist(secondTrackIds);
    },
    async getPlaybackAvailability() {
      this.playbackCalls += 1;
      if (playbackError) throw playbackError;
      return availability;
    },
  };
}

test("a stable missing observation is accepted after a second complete membership read", async () => {
  const client = fakeClient({ secondTrackIds: ["2"] });
  const snapshot = account([{ id: "2", playable: true }]);
  await verifySnapshotAnomalies(client, session, snapshot, {
    managedSongs: [managed("1"), managed("2")],
  });
  assert.equal(client.playlistCalls, 1);
  assert.equal(client.playbackCalls, 0);
});

test("a changing playlist aborts verification before state commit", async () => {
  const client = fakeClient({ secondTrackIds: ["1", "2"] });
  const snapshot = account([{ id: "2", playable: true }]);
  await assert.rejects(
    verifySnapshotAnomalies(client, session, snapshot, {
      managedSongs: [managed("1"), managed("2")],
    }),
    (error) => error instanceof NeteaseError && error.kind === "incomplete_response",
  );
});

test("a second unplayable result confirms a grey observation", async () => {
  const client = fakeClient({
    availability: [{ id: "1", playable: false, code: 404, reason: "no_url", freeTrial: false }],
  });
  const snapshot = account([{ id: "1", playable: false }]);
  const verified = await verifySnapshotAnomalies(client, session, snapshot, {
    managedSongs: [managed("1")],
  });
  assert.equal(verified.songs[0].playable, false);
  assert.equal(client.playbackCalls, 1);
});

test("a playable recheck suppresses a transient grey observation", async () => {
  const client = fakeClient({
    availability: [{ id: "1", playable: true, code: 200, reason: "playable", freeTrial: false }],
  });
  const snapshot = account([{ id: "1", playable: false }]);
  const verified = await verifySnapshotAnomalies(client, session, snapshot, {
    managedSongs: [managed("1")],
  });
  assert.equal(verified.songs[0].playable, true);
  assert.equal(verified.songs[0].playbackCode, 200);
});

test("verification failures are propagated instead of producing partial state", async () => {
  const failure = new NeteaseError("network", "temporary failure");
  const client = fakeClient({ playbackError: failure });
  await assert.rejects(
    verifySnapshotAnomalies(
      client,
      session,
      account([{ id: "1", playable: false }]),
      { managedSongs: [managed("1")] },
    ),
    failure,
  );
});

test("no extra upstream request is made when no new anomaly is suspected", async () => {
  const client = fakeClient();
  const snapshot = account([{ id: "1", playable: true }]);
  await verifySnapshotAnomalies(client, session, snapshot, {
    managedSongs: [managed("1")],
  });
  assert.equal(client.playlistCalls, 0);
  assert.equal(client.playbackCalls, 0);
});
