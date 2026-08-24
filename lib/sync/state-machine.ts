export type RecoveryType = "missing" | "grey";
export type ManagedBucket = "normal" | "anomaly";

export interface SnapshotSong {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  coverUrl: string | null;
  neteaseUrl?: string;
  /** Account-level result after official-resource and personal-cloud matching. */
  accountPlayable: boolean;
}

export interface CompletePlaylistSnapshot {
  observedAt: string;
  declaredTrackCount: number;
  complete: true;
  songs: SnapshotSong[];
}

export interface ManagedSongState {
  songId: string;
  bucket: ManagedBucket;
  anomalyType: RecoveryType | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastConfirmedAt?: string;
  lastPlayableAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncState {
  managedSongs: ManagedSongState[];
}

export interface SyncPlan {
  observedAt: string;
  shanghaiDate: string;
  baselineEstablished: boolean;
  songUpserts: SnapshotSong[];
  managedSongUpserts: ManagedSongState[];
  result: {
    currentSongCount: number;
    newCount: number;
    confirmedMissingCount: number;
    confirmedGreyCount: number;
    autoRecoveredCount: number;
    newlyConfirmedSongIds: string[];
    automaticallyRecoveredSongIds: string[];
  };
}

export class InvalidSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InvalidSnapshotError";
    this.code = code;
  }
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function toShanghaiDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidSnapshotError("INVALID_OBSERVED_AT", "observedAt must be a valid timestamp");
  }

  const parts = Object.fromEntries(
    SHANGHAI_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function assertCompleteSnapshot(
  snapshot: CompletePlaylistSnapshot,
): CompletePlaylistSnapshot {
  toShanghaiDate(snapshot.observedAt);

  if (snapshot.complete !== true) {
    throw new InvalidSnapshotError("INCOMPLETE_SNAPSHOT", "snapshot was not marked complete");
  }
  if (!Number.isSafeInteger(snapshot.declaredTrackCount) || snapshot.declaredTrackCount <= 0) {
    throw new InvalidSnapshotError(
      "INVALID_TRACK_COUNT",
      "declaredTrackCount must be a positive safe integer",
    );
  }
  if (snapshot.songs.length !== snapshot.declaredTrackCount) {
    throw new InvalidSnapshotError(
      "TRACK_COUNT_MISMATCH",
      `expected ${snapshot.declaredTrackCount} tracks, received ${snapshot.songs.length}`,
    );
  }

  const ids = new Set<string>();
  for (const song of snapshot.songs) {
    if (!song.id.trim() || !song.title.trim()) {
      throw new InvalidSnapshotError("INVALID_SONG", "every song must have a non-empty id and title");
    }
    if (ids.has(song.id)) {
      throw new InvalidSnapshotError("DUPLICATE_SONG", `duplicate song id ${song.id}`);
    }
    ids.add(song.id);
    if (!Array.isArray(song.artists) || song.artists.some((artist) => typeof artist !== "string")) {
      throw new InvalidSnapshotError("INVALID_ARTISTS", `song ${song.id} has invalid artists`);
    }
    if (typeof song.accountPlayable !== "boolean") {
      throw new InvalidSnapshotError(
        "MISSING_PLAYABILITY",
        `song ${song.id} has no account-level playability result`,
      );
    }
  }
  return snapshot;
}

function clearAnomaly(row: ManagedSongState): ManagedSongState {
  return {
    ...row,
    bucket: "normal",
    anomalyType: null,
    confirmedAt: null,
  };
}

function confirmAnomaly(
  row: ManagedSongState,
  type: RecoveryType,
  observedAt: string,
): ManagedSongState {
  return {
    ...row,
    bucket: "anomaly",
    anomalyType: type,
    confirmedAt: observedAt,
    updatedAt: observedAt,
  };
}

function sameManagedSong(a: ManagedSongState, b: ManagedSongState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pure state transition. The repository commits every returned upsert and the
 * successful sync_run as one atomic D1 batch.
 */
export function planSnapshotSync(
  input: CompletePlaylistSnapshot,
  state: SyncState,
): SyncPlan {
  const snapshot = assertCompleteSnapshot(input);
  const observedAt = new Date(snapshot.observedAt).toISOString();
  const shanghaiDate = toShanghaiDate(observedAt);
  const baselineEstablished = state.managedSongs.length === 0;
  const original = new Map(
    state.managedSongs.map((row) => [row.songId, { ...row }]),
  );
  const managed = new Map(
    state.managedSongs.map((row) => [row.songId, { ...row }]),
  );
  const snapshotById = new Map(snapshot.songs.map((song) => [song.id, song]));
  const newlyConfirmedSongIds: string[] = [];
  const automaticallyRecoveredSongIds: string[] = [];
  let confirmedMissingCount = 0;
  let confirmedGreyCount = 0;
  let newCount = 0;

  for (const song of snapshot.songs) {
    const existing = managed.get(song.id);
    if (!existing) {
      let created: ManagedSongState = {
        songId: song.id,
        bucket: "normal",
        anomalyType: null,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        lastConfirmedAt: observedAt,
        lastPlayableAt: song.accountPlayable || baselineEstablished ? observedAt : null,
        confirmedAt: null,
        createdAt: observedAt,
        updatedAt: observedAt,
      };
      if (!song.accountPlayable) {
        created = confirmAnomaly(created, "grey", observedAt);
        newlyConfirmedSongIds.push(song.id);
        confirmedGreyCount += 1;
      }
      managed.set(song.id, created);
      if (!baselineEstablished) newCount += 1;
      continue;
    }

    let next: ManagedSongState = {
      ...existing,
      lastSeenAt: observedAt,
      lastConfirmedAt: observedAt,
      lastPlayableAt: song.accountPlayable ? observedAt : existing.lastPlayableAt,
      updatedAt: observedAt,
    };

    if (existing.bucket === "anomaly") {
      if (song.accountPlayable) {
        next = clearAnomaly(next);
        automaticallyRecoveredSongIds.push(song.id);
      }
      // A confirmed anomaly keeps its original type while absent or unplayable.
    } else if (!song.accountPlayable) {
      next = confirmAnomaly(next, "grey", observedAt);
      newlyConfirmedSongIds.push(song.id);
      confirmedGreyCount += 1;
    }
    managed.set(song.id, next);
  }

  for (const existing of original.values()) {
    if (snapshotById.has(existing.songId) || existing.bucket === "anomaly") continue;
    managed.set(existing.songId, {
      ...confirmAnomaly(existing, "missing", observedAt),
      lastConfirmedAt: observedAt,
    });
    newlyConfirmedSongIds.push(existing.songId);
    confirmedMissingCount += 1;
  }

  const managedSongUpserts = [...managed.values()].filter((row) => {
    const before = original.get(row.songId);
    return !before || !sameManagedSong(before, row);
  });

  return {
    observedAt,
    shanghaiDate,
    baselineEstablished,
    songUpserts: snapshot.songs.map((song) => ({
      ...song,
      neteaseUrl: song.neteaseUrl ?? `https://music.163.com/#/song?id=${encodeURIComponent(song.id)}`,
    })),
    managedSongUpserts,
    result: {
      currentSongCount: managed.size,
      newCount,
      confirmedMissingCount,
      confirmedGreyCount,
      autoRecoveredCount: automaticallyRecoveredSongIds.length,
      newlyConfirmedSongIds,
      automaticallyRecoveredSongIds,
    },
  };
}
