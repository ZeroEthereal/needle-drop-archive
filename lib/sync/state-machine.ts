export type RecoveryType = "missing" | "grey" | "mismatch";
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
  songs?: SongMetadata[];
}

export interface SongMetadata {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  coverUrl: string | null;
  neteaseUrl?: string;
  observedTitle: string | null;
  observedArtists: string[] | null;
}

export interface SongUpsert extends SnapshotSong, SongMetadata {
  sourceState: "normal" | "grey" | "mismatch";
}

export function sameSongIdentity(left: Pick<SnapshotSong, "title" | "artists">,
  right: Pick<SnapshotSong, "title" | "artists">): boolean {
  return left.title === right.title && JSON.stringify(left.artists) === JSON.stringify(right.artists);
}

export interface SyncPlan {
  observedAt: string;
  shanghaiDate: string;
  baselineEstablished: boolean;
  songUpserts: SongUpsert[];
  managedSongUpserts: ManagedSongState[];
  result: {
    currentSongCount: number;
    newCount: number;
    confirmedMissingCount: number;
    confirmedGreyCount: number;
    confirmedMismatchCount: number;
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
  allowEmpty = false,
): CompletePlaylistSnapshot {
  toShanghaiDate(snapshot.observedAt);

  if (snapshot.complete !== true) {
    throw new InvalidSnapshotError("INCOMPLETE_SNAPSHOT", "snapshot was not marked complete");
  }
  if (!Number.isSafeInteger(snapshot.declaredTrackCount) || snapshot.declaredTrackCount < (allowEmpty ? 0 : 1)) {
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
  baselineAlreadyEstablished?: boolean,
): SyncPlan {
  const snapshot = assertCompleteSnapshot(input, baselineAlreadyEstablished === true);
  const observedAt = new Date(snapshot.observedAt).toISOString();
  const shanghaiDate = toShanghaiDate(observedAt);
  const baselineEstablished = baselineAlreadyEstablished === undefined
    ? state.managedSongs.length === 0
    : !baselineAlreadyEstablished;
  const original = new Map(
    state.managedSongs.map((row) => [row.songId, { ...row }]),
  );
  const managed = new Map(
    state.managedSongs.map((row) => [row.songId, { ...row }]),
  );
  const snapshotById = new Map(snapshot.songs.map((song) => [song.id, song]));
  const metadataById = new Map((state.songs ?? []).map((song) => [song.id, song]));
  const songUpserts: SongUpsert[] = snapshot.songs.map((song) => {
    const stored = metadataById.get(song.id);
    const sourceState = !song.accountPlayable ? "grey" :
      stored && !sameSongIdentity(stored, song) ? "mismatch" : "normal";
    return {
      ...song,
      title: stored?.title ?? song.title,
      artists: stored?.artists ?? song.artists,
      album: sourceState !== "normal" && stored ? stored.album : song.album,
      coverUrl: sourceState !== "normal" && stored ? stored.coverUrl : song.coverUrl,
      neteaseUrl: stored?.neteaseUrl ?? song.neteaseUrl ??
        `https://music.163.com/#/song?id=${encodeURIComponent(song.id)}`,
      observedTitle: sourceState === "grey" ? stored?.observedTitle ?? null :
        sourceState === "mismatch" ? song.title : null,
      observedArtists: sourceState === "grey" ? stored?.observedArtists ?? null :
        sourceState === "mismatch" ? [...song.artists] : null,
      sourceState,
    };
  });
  const newlyConfirmedSongIds: string[] = [];
  const automaticallyRecoveredSongIds: string[] = [];
  let confirmedMissingCount = 0;
  let confirmedGreyCount = 0;
  let confirmedMismatchCount = 0;
  let newCount = 0;

  for (const song of songUpserts) {
    const existing = managed.get(song.id);
    const type = song.sourceState === "normal" ? null : song.sourceState;
    const next: ManagedSongState = {
      ...(existing ?? {
        songId: song.id,
        bucket: "normal",
        anomalyType: null,
        firstSeenAt: observedAt,
        lastPlayableAt: null,
        confirmedAt: null,
        createdAt: observedAt,
      } satisfies Partial<ManagedSongState>),
      bucket: type ? "anomaly" : "normal",
      anomalyType: type,
      lastSeenAt: observedAt,
      lastConfirmedAt: observedAt,
      lastPlayableAt: type === null ? observedAt : existing?.lastPlayableAt ?? null,
      confirmedAt: type === null ? null : existing?.anomalyType === type ?
        existing.confirmedAt : observedAt,
      updatedAt: observedAt,
    };
    if (!existing && !baselineEstablished) newCount += 1;
    if (type && existing?.anomalyType !== type) {
      newlyConfirmedSongIds.push(song.id);
      if (type === "grey") confirmedGreyCount += 1;
      else confirmedMismatchCount += 1;
    }
    if (!type && existing?.bucket === "anomaly") automaticallyRecoveredSongIds.push(song.id);
    managed.set(song.id, next);
  }

  for (const existing of original.values()) {
    if (snapshotById.has(existing.songId)) continue;
    managed.set(existing.songId, {
      ...existing,
      bucket: "anomaly",
      anomalyType: "missing",
      confirmedAt: existing.anomalyType === "missing" ? existing.confirmedAt : observedAt,
      lastConfirmedAt: observedAt,
      updatedAt: observedAt,
    });
    if (existing.anomalyType !== "missing") {
      newlyConfirmedSongIds.push(existing.songId);
      confirmedMissingCount += 1;
    }
  }

  const managedSongUpserts = [...managed.values()].filter((row) => {
    const before = original.get(row.songId);
    return !before || !sameManagedSong(before, row);
  });

  return {
    observedAt,
    shanghaiDate,
    baselineEstablished,
    songUpserts,
    managedSongUpserts,
    result: {
      currentSongCount: managed.size,
      newCount,
      confirmedMissingCount,
      confirmedGreyCount,
      confirmedMismatchCount,
      autoRecoveredCount: automaticallyRecoveredSongIds.length,
      newlyConfirmedSongIds,
      automaticallyRecoveredSongIds,
    },
  };
}
