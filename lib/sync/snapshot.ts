import { NeteaseClient, NeteaseError } from "../netease";
import type { CompletePlaylistSnapshot } from "./state-machine";

export function snapshotForStateMachine(account: Awaited<ReturnType<NeteaseClient["getAccountSnapshot"]>>): CompletePlaylistSnapshot {
  const songsById = new Map(account.songs.map((song) => [song.id, song]));
  return {
    observedAt: account.capturedAt,
    declaredTrackCount: account.trackIds.length,
    complete: true,
    songs: account.trackIds.map((id) => {
      const item = songsById.get(id);
      if (!item) throw new NeteaseError("incomplete_response", "歌单成员缺少对应歌曲资料，本次同步已停止。");
      return {
        id: item.id,
        title: item.song.title,
        artists: item.song.artists.map((artist) => artist.name),
        album: item.song.album.name,
        coverUrl: item.song.album.coverUrl,
        aliases: item.song.aliases,
        translations: item.song.translations,
        durationMs: item.song.durationMs,
        neteaseUrl: item.song.neteaseUrl,
        accountPlayable: item.playable,
      };
    }),
  };
}
