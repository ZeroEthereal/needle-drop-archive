import type { D1DatabasePort } from "./repository";
import type { SongMetadata, SongUpsert } from "./state-machine";
import { normalizeSongTextList, validSongDuration } from "../song-display.ts";

export interface SongDisplayDbRow {
  aliases: string | null;
  translations: string | null;
  duration_ms: number | null;
}

export function readSongDisplayMetadata(row: SongDisplayDbRow) {
  return {
    aliases: row.aliases === null ? null : normalizeSongTextList(JSON.parse(row.aliases)),
    translations: row.translations === null ? null : normalizeSongTextList(JSON.parse(row.translations)),
    durationMs: validSongDuration(row.duration_ms),
  };
}

export async function loadSongMetadata(db: D1DatabasePort): Promise<SongMetadata[]> {
  const result = await db.prepare(`SELECT id, title, artists, album, cover_url, netease_url,
    observed_title, observed_artists, aliases, translations, duration_ms FROM songs`).all<SongDisplayDbRow & {
      id: string; title: string; artists: string; album: string | null;
      cover_url: string | null; netease_url: string;
      observed_title: string | null; observed_artists: string | null;
    }>();
  if (!result.success) throw new Error(result.error || "Could not load song metadata");
  return (result.results ?? []).map((row) => ({ id: row.id, title: row.title,
    artists: JSON.parse(row.artists), album: row.album, coverUrl: row.cover_url,
    ...readSongDisplayMetadata(row), neteaseUrl: row.netease_url, observedTitle: row.observed_title,
    observedArtists: row.observed_artists === null ? null : JSON.parse(row.observed_artists) }));
}

export function encodeSongUpserts(songs: SongUpsert[]): string {
  return JSON.stringify(songs.map((song) => ({ ...song, artists: JSON.stringify(song.artists),
    aliases: song.aliases == null ? null : JSON.stringify(normalizeSongTextList(song.aliases)),
    translations: song.translations == null ? null : JSON.stringify(normalizeSongTextList(song.translations)),
    durationMs: validSongDuration(song.durationMs),
    observedArtists: song.observedArtists === null ? null : JSON.stringify(song.observedArtists) })));
}

export function decodeSongUpserts(payload: string): SongUpsert[] {
  return (JSON.parse(payload) as Array<Omit<SongUpsert, "artists" | "observedArtists" | "aliases" | "translations"> & {
    artists: string; observedArtists: string | null; aliases?: string | null; translations?: string | null;
  }>).map((song) => ({ ...song, artists: JSON.parse(song.artists),
    aliases: song.aliases == null ? null : normalizeSongTextList(JSON.parse(song.aliases)),
    translations: song.translations == null ? null : normalizeSongTextList(JSON.parse(song.translations)),
    durationMs: validSongDuration(song.durationMs),
    observedArtists: song.observedArtists == null ? null : JSON.parse(song.observedArtists) }));
}

export function stagedSongMetadata(originals: SongMetadata[], payloads: string[]): SongMetadata[] {
  const byId = new Map(originals.map((song) => [song.id, song]));
  for (const payload of payloads) for (const song of decodeSongUpserts(payload)) {
    if (!["normal", "grey", "mismatch"].includes(song.sourceState)) continue;
    const stored = byId.get(song.id);
    byId.set(song.id, { ...song, title: stored?.title ?? song.title, artists: stored?.artists ?? song.artists });
  }
  return [...byId.values()];
}

/** All sync/binding writers preserve the first identity for an existing ID. */
export function upsertSongsSql(guard: string): string {
  return `INSERT INTO songs (id, title, artists, album, cover_url, netease_url,
    observed_title, observed_artists, aliases, translations, duration_ms, created_at, updated_at)
    SELECT json_extract(value, '$.id'), json_extract(value, '$.title'),
      json_extract(value, '$.artists'), json_extract(value, '$.album'),
      json_extract(value, '$.coverUrl'), json_extract(value, '$.neteaseUrl'),
      json_extract(value, '$.observedTitle'), json_extract(value, '$.observedArtists'),
      json_extract(value, '$.aliases'), json_extract(value, '$.translations'), json_extract(value, '$.durationMs'),
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM json_each(?) WHERE ${guard}
    ON CONFLICT(id) DO UPDATE SET album = excluded.album, cover_url = excluded.cover_url,
      observed_title = excluded.observed_title, observed_artists = excluded.observed_artists,
      aliases = excluded.aliases, translations = excluded.translations, duration_ms = excluded.duration_ms,
      netease_url = excluded.netease_url, updated_at = CURRENT_TIMESTAMP`;
}

/** Source status follows the ID; membership and last_seen_at remain playlist-specific. */
export function propagateSourceSql(guard: string): string {
  // A CTE binds the payload once, so the same verified observation drives all columns.
  return `WITH observations AS (SELECT json_extract(value, '$.id') AS id,
    json_extract(value, '$.sourceState') AS state FROM json_each(?))
    UPDATE playlist_song_states SET
      bucket = CASE WHEN observations.state = 'normal'
        THEN 'normal' ELSE 'anomaly' END,
      confirmed_at = CASE WHEN observations.state = 'normal'
        THEN NULL WHEN anomaly_type = observations.state
        THEN confirmed_at ELSE ? END,
      last_playable_at = CASE WHEN observations.state = 'normal'
        THEN ? ELSE last_playable_at END,
      anomaly_type = NULLIF(observations.state, 'normal'),
      last_confirmed_at = ?, updated_at = ?
    FROM observations WHERE playlist_song_states.song_id = observations.id
      AND (anomaly_type IS NULL OR anomaly_type <> 'missing')
      AND (julianday(last_confirmed_at) IS NULL OR julianday(last_confirmed_at) <= julianday(?))
      AND ${guard}`;
}
