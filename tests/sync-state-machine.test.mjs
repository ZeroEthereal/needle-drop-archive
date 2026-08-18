import assert from "node:assert/strict";
import test from "node:test";

import { InvalidSnapshotError, planSnapshotSync } from "../lib/sync/state-machine.ts";

const songA = {
  id: "431534223",
  title: "习惯了寂寞",
  artists: ["牛奶咖啡"],
  album: "习惯了寂寞",
  coverUrl: null,
  accountPlayable: true,
};

const stableSong = {
  id: "1413863166",
  title: "想去海边",
  artists: ["夏日入侵企画"],
  album: null,
  coverUrl: null,
  accountPlayable: true,
};

const replacementSong = {
  ...songA,
  id: "900000001",
  title: "习惯了寂寞（云盘版）",
};

function snapshot(observedAt, songs) {
  return {
    observedAt,
    declaredTrackCount: songs.length,
    complete: true,
    songs,
  };
}

function apply(state, plan) {
  const managed = new Map(state.managedSongs.map((row) => [row.songId, row]));
  for (const row of plan.managedSongUpserts) managed.set(row.songId, row);
  return { managedSongs: [...managed.values()] };
}

function sync(state, observedAt, songs) {
  const plan = planSnapshotSync(snapshot(observedAt, songs), state);
  return { plan, state: apply(state, plan) };
}

function managed(state, songId = songA.id) {
  return state.managedSongs.find((row) => row.songId === songId);
}

test("rejects an incomplete snapshot before producing mutations", () => {
  assert.throws(
    () => planSnapshotSync(
      { observedAt: "2026-07-16T00:00:00Z", declaredTrackCount: 1, complete: true, songs: [] },
      { managedSongs: [] },
    ),
    (error) => error instanceof InvalidSnapshotError && error.code === "TRACK_COUNT_MISMATCH",
  );
});

test("a verified missing observation becomes an anomaly immediately", () => {
  let state = { managedSongs: [] };
  ({ state } = sync(state, "2026-07-15T01:00:00Z", [songA, stableSong]));
  const turn = sync(state, "2026-07-15T10:00:00Z", [stableSong]);
  assert.equal(managed(turn.state).bucket, "anomaly");
  assert.equal(managed(turn.state).anomalyType, "missing");
  assert.equal(turn.plan.result.confirmedMissingCount, 1);
});

test("a verified grey observation becomes an anomaly immediately", () => {
  let state = { managedSongs: [] };
  ({ state } = sync(state, "2026-07-15T01:00:00Z", [songA, stableSong]));
  const turn = sync(state, "2026-07-15T10:00:00Z", [
    { ...songA, accountPlayable: false },
    stableSong,
  ]);
  assert.equal(managed(turn.state).bucket, "anomaly");
  assert.equal(managed(turn.state).anomalyType, "grey");
  assert.equal(turn.plan.result.confirmedGreyCount, 1);
});

test("an unplayable song in a new baseline is classified as grey", () => {
  const turn = sync(
    { managedSongs: [] },
    "2026-07-15T01:00:00Z",
    [{ ...songA, accountPlayable: false }, stableSong],
  );
  assert.equal(managed(turn.state).bucket, "anomaly");
  assert.equal(managed(turn.state).anomalyType, "grey");
  assert.equal(turn.plan.result.confirmedGreyCount, 1);
});

test("a confirmed anomaly recovers after one playable observation", () => {
  let state = { managedSongs: [] };
  ({ state } = sync(state, "2026-07-15T01:00:00Z", [songA, stableSong]));
  ({ state } = sync(state, "2026-07-16T01:00:00Z", [stableSong]));
  assert.equal(managed(state).bucket, "anomaly");

  const turn = sync(state, "2026-07-17T01:00:00Z", [songA, stableSong]);
  state = turn.state;
  assert.equal(managed(state).bucket, "normal");
  assert.equal(managed(state).anomalyType, null);
  assert.deepEqual(turn.plan.result.automaticallyRecoveredSongIds, [songA.id]);
});

test("confirmed grey remains grey after the favorite disappears", () => {
  let state = { managedSongs: [] };
  ({ state } = sync(state, "2026-07-15T01:00:00Z", [songA, stableSong]));
  ({ state } = sync(state, "2026-07-16T01:00:00Z", [{ ...songA, accountPlayable: false }, stableSong]));
  ({ state } = sync(state, "2026-07-17T01:00:00Z", [stableSong]));

  assert.equal(managed(state).bucket, "anomaly");
  assert.equal(managed(state).anomalyType, "grey");
});

test("confirmed missing remains missing when it reappears but is unplayable", () => {
  let state = { managedSongs: [] };
  ({ state } = sync(state, "2026-07-15T01:00:00Z", [songA, stableSong]));
  ({ state } = sync(state, "2026-07-16T01:00:00Z", [stableSong]));
  ({ state } = sync(state, "2026-07-17T01:00:00Z", [{ ...songA, accountPlayable: false }, stableSong]));

  assert.equal(managed(state).bucket, "anomaly");
  assert.equal(managed(state).anomalyType, "missing");
});

test("an anomalous old id and a replacement id remain independent", () => {
  let state = { managedSongs: [] };
  ({ state } = sync(state, "2026-07-15T01:00:00Z", [songA, stableSong]));
  ({ state } = sync(state, "2026-07-16T01:00:00Z", [stableSong]));
  ({ state } = sync(state, "2026-07-17T01:00:00Z", [replacementSong, stableSong]));

  assert.equal(managed(state, songA.id).bucket, "anomaly");
  assert.equal(managed(state, replacementSong.id).bucket, "normal");
  assert.equal(state.managedSongs.length, 3);
});
