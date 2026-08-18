import {
  NeteaseError,
  type AccountSnapshot,
  type NeteaseSession,
  type PlaybackAvailability,
  type PlaylistDetail,
} from "../lib/netease/index.ts";
import type { SyncState } from "../lib/sync/state-machine.ts";

export interface SnapshotVerificationClient {
  getPlaylistDetail(
    playlistId: string | number,
    session?: NeteaseSession,
  ): Promise<PlaylistDetail>;
  getPlaybackAvailability(
    ids: readonly (string | number)[],
    session: NeteaseSession,
  ): Promise<PlaybackAvailability[]>;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function assertCompleteMembership(playlist: PlaylistDetail): void {
  if (playlist.trackCount <= 0 || playlist.trackIds.length < playlist.trackCount) {
    throw new NeteaseError(
      "incomplete_response",
      "网易云歌单复核没有返回完整成员，本次同步已停止。",
      { endpoint: "/api/v6/playlist/detail" },
    );
  }
}

/**
 * Rechecks only observations that would move a normal song into an anomaly.
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
    (row) => row.bucket === "normal" && !firstMembership.has(row.songId),
  );

  if (suspectedMissing.length > 0) {
    const secondPlaylist = await client.getPlaylistDetail(account.playlist.id, session);
    assertCompleteMembership(secondPlaylist);
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
      return !existing || existing.bucket === "normal";
    })
    .map((song) => song.id);

  if (suspectedGreyIds.length === 0) return account;

  const secondAvailability = await client.getPlaybackAvailability(suspectedGreyIds, session);
  const availabilityById = new Map(secondAvailability.map((item) => [item.id, item]));
  if (availabilityById.size !== suspectedGreyIds.length) {
    throw new NeteaseError(
      "incomplete_response",
      "网易云播放状态复核结果不完整，本次同步已停止。",
      { endpoint: "/api/song/enhance/player/url" },
    );
  }

  return {
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
}
