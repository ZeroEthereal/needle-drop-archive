import {
  NeteaseError,
  type AccountSnapshot,
  type NeteaseSession,
  type PlaybackAvailability,
  type PlaylistDetail,
  type SongSummary,
} from "../lib/netease/index.ts";
import { sameSongIdentity, type SyncState } from "../lib/sync/state-machine.ts";

export interface SnapshotVerificationClient {
  getPlaylistDetail(
    playlistId: string | number,
    session?: NeteaseSession,
  ): Promise<PlaylistDetail>;
  getPlaybackAvailability(
    ids: readonly (string | number)[],
    session: NeteaseSession,
  ): Promise<PlaybackAvailability[]>;
  getSongMetadata(ids: readonly string[], session: NeteaseSession,
    playlist: string): Promise<{ songs: Array<{ id: string; song: SongSummary }> }>;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function assertCompleteMembership(playlist: PlaylistDetail, allowEmpty = false): void {
  if (playlist.trackCount < (allowEmpty ? 0 : 1) || playlist.trackIds.length < playlist.trackCount) {
    throw new NeteaseError(
      "incomplete_response",
      "网易云歌单复核没有返回完整成员，本次同步已停止。",
      { endpoint: "/api/v6/playlist/detail" },
    );
  }
}

/**
 * Rechecks new anomaly types and changed/restored song identity before committing.
 * Any incomplete or changing upstream result aborts before D1 state is written.
 */
export async function verifySnapshotAnomalies(
  client: SnapshotVerificationClient,
  session: NeteaseSession,
  account: AccountSnapshot,
  state: SyncState,
): Promise<AccountSnapshot> {
  const firstMembership = new Set(account.trackIds);
  const suspectedMissing = state.managedSongs.filter(
    (row) => row.anomalyType !== "missing" && !firstMembership.has(row.songId),
  );

  if (suspectedMissing.length > 0) {
    const secondPlaylist = await client.getPlaylistDetail(account.playlist.id, session);
    assertCompleteMembership(secondPlaylist, account.trackIds.length === 0);
    if (!sameIds(account.trackIds, secondPlaylist.trackIds)) {
      throw new NeteaseError(
        "incomplete_response",
        "网易云歌单在同步复核期间发生变化，本次同步未写入任何歌曲状态。",
        { endpoint: "/api/v6/playlist/detail", retryable: true },
      );
    }
  }

  const stateById = new Map(state.managedSongs.map((row) => [row.songId, row]));
  const suspectedGreyIds = account.songs
    .filter((song) => {
      if (song.playable) return false;
      const existing = stateById.get(song.id);
      return !existing || existing.anomalyType !== "grey";
    })
    .map((song) => song.id);

  const secondAvailability = suspectedGreyIds.length > 0
    ? await client.getPlaybackAvailability(suspectedGreyIds, session) : [];
  const availabilityById = new Map(secondAvailability.map((item) => [item.id, item]));
  if (availabilityById.size !== suspectedGreyIds.length) {
    throw new NeteaseError(
      "incomplete_response",
      "网易云播放状态复核结果不完整，本次同步已停止。",
      { endpoint: "/api/song/enhance/player/url" },
    );
  }

  const verifiedAccount = {
    ...account,
    songs: account.songs.map((song) => {
      const verified = availabilityById.get(song.id);
      return verified
        ? {
            ...song,
            playable: verified.playable,
            playbackCode: verified.code,
            playbackReason: verified.reason,
          }
        : song;
    }),
  };
  const originals = new Map((state.songs ?? []).map((song) => [song.id, song]));
  const changedIds = verifiedAccount.songs.filter((item) => {
    const original = originals.get(item.id);
    return item.playable && original && (!sameSongIdentity(original, {
      title: item.song.title, artists: item.song.artists.map((artist) => artist.name),
    }) || original.observedTitle !== null);
  }).map((item) => item.id);
  if (changedIds.length) {
    const second = await client.getSongMetadata(changedIds, session, account.playlist.id);
    const byId = new Map(second.songs.map((item) => [item.id, item.song]));
    for (const id of changedIds) {
      const first = verifiedAccount.songs.find((item) => item.id === id)!.song;
      const next = byId.get(id);
      if (!next || first.title !== next.title ||
        JSON.stringify(first.artists.map((artist) => artist.name)) !==
        JSON.stringify(next.artists.map((artist) => artist.name))) {
        throw new NeteaseError("incomplete_response",
          "网易云歌曲资料复核不完整或发生变化，本次同步未写入歌曲状态。",
          { endpoint: "/api/v3/song/detail", retryable: true });
      }
    }
  }
  return verifiedAccount;
}
