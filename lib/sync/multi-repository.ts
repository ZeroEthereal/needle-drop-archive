import type { D1DatabasePort } from "./repository";
import type { ManagedSongState, SyncPlan, SyncState } from "./state-machine";

export interface MonitoredPlaylist {
  id: string;
  name: string;
  coverUrl: string | null;
  ownerUid: string;
  ownerName: string;
  owned: boolean;
  specialType: number | null;
  listOrder: number;
  baselineEstablished: boolean;
  boundAt: string;
  totalSongCount: number;
  normalCount: number;
  missingCount: number;
  greyCount: number;
}

interface PlaylistRow {
  id: string; name: string; cover_url: string | null; owner_uid: string; owner_name: string;
  owned: number; special_type: number | null; list_order: number; baseline_established: number;
  bound_at: string; total_count: number; normal_count: number; missing_count: number; grey_count: number;
}

export async function listMonitoredPlaylists(db: D1DatabasePort): Promise<MonitoredPlaylist[]> {
  const result = await db.prepare(`
    SELECT p.id, p.name, p.cover_url, p.owner_uid, p.owner_name, p.owned,
           p.special_type, p.list_order, p.baseline_established, p.bound_at,
           COUNT(s.song_id) AS total_count,
           SUM(CASE WHEN s.bucket = 'normal' THEN 1 ELSE 0 END) AS normal_count,
           SUM(CASE WHEN s.anomaly_type = 'missing' THEN 1 ELSE 0 END) AS missing_count,
           SUM(CASE WHEN s.anomaly_type = 'grey' THEN 1 ELSE 0 END) AS grey_count
    FROM monitored_playlists p LEFT JOIN playlist_song_states s ON s.playlist_id = p.id
    GROUP BY p.id ORDER BY p.list_order, p.id
  `).all<PlaylistRow>();
  if (!result.success) throw new Error(result.error || "Could not load monitored playlists");
  return (result.results ?? []).map((row) => ({
    id: row.id, name: row.name, coverUrl: row.cover_url, ownerUid: row.owner_uid,
    ownerName: row.owner_name, owned: row.owned === 1, specialType: row.special_type,
    listOrder: row.list_order, baselineEstablished: row.baseline_established === 1,
    boundAt: row.bound_at, totalSongCount: Number(row.total_count || 0),
    normalCount: Number(row.normal_count || 0), missingCount: Number(row.missing_count || 0),
    greyCount: Number(row.grey_count || 0),
  }));
}

export function defaultPlaylist(playlists: MonitoredPlaylist[]): MonitoredPlaylist | null {
  return playlists.find((item) => item.specialType === 5) ??
    [...playlists].sort((a, b) => b.totalSongCount - a.totalSongCount || a.listOrder - b.listOrder)[0] ?? null;
}

export async function loadPlaylistSyncState(db: D1DatabasePort, playlistId: string): Promise<SyncState> {
  const result = await db.prepare(`
    SELECT song_id, bucket, anomaly_type, first_seen_at, last_seen_at,
           last_confirmed_at, last_playable_at, confirmed_at, created_at, updated_at
    FROM playlist_song_states WHERE playlist_id = ?
  `).bind(playlistId).all<{
    song_id: string; bucket: "normal" | "anomaly"; anomaly_type: "missing" | "grey" | null;
    first_seen_at: string; last_seen_at: string; last_confirmed_at: string;
    last_playable_at: string | null; confirmed_at: string | null; created_at: string; updated_at: string;
  }>();
  if (!result.success) throw new Error(result.error || "Could not load playlist state");
  return { managedSongs: (result.results ?? []).map((row): ManagedSongState => ({
    songId: row.song_id, bucket: row.bucket, anomalyType: row.anomaly_type,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    lastConfirmedAt: row.last_confirmed_at, lastPlayableAt: row.last_playable_at,
    confirmedAt: row.confirmed_at, createdAt: row.created_at, updatedAt: row.updated_at,
  })) };
}

export async function commitPlaylistSyncPlan(
  db: D1DatabasePort, playlistId: string, plan: SyncPlan,
  batchId: string, bindingVersion: number,
): Promise<void> {
  const guard = `EXISTS (SELECT 1 FROM instance_config i JOIN monitored_playlists p ON p.id = ?
    WHERE i.id = 'primary' AND i.binding_version = ? AND i.status = 'ready'
      AND EXISTS (SELECT 1 FROM sync_playlist_tasks t WHERE t.batch_id = ?
        AND t.playlist_id = p.id AND t.status = 'running' AND t.binding_version = ?))`;
  const statements = [
    db.prepare(`INSERT INTO songs (id, title, artists, album, cover_url, netease_url, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.title'),
        json_extract(value, '$.artists'), json_extract(value, '$.album'),
        json_extract(value, '$.coverUrl'), json_extract(value, '$.neteaseUrl'),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM json_each(?) WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, artists = excluded.artists,
        album = excluded.album, cover_url = excluded.cover_url,
        netease_url = excluded.netease_url, updated_at = CURRENT_TIMESTAMP`
    ).bind(JSON.stringify(plan.songUpserts.map((song) => ({ ...song, artists: JSON.stringify(song.artists) }))),
      playlistId, bindingVersion, batchId, bindingVersion),
    db.prepare(`INSERT INTO playlist_song_states (
      playlist_id, song_id, bucket, anomaly_type, first_seen_at, last_seen_at,
      last_confirmed_at, last_playable_at, confirmed_at, created_at, updated_at)
      SELECT ?, json_extract(value, '$.songId'), json_extract(value, '$.bucket'),
        json_extract(value, '$.anomalyType'), json_extract(value, '$.firstSeenAt'),
        json_extract(value, '$.lastSeenAt'), json_extract(value, '$.lastConfirmedAt'),
        json_extract(value, '$.lastPlayableAt'), json_extract(value, '$.confirmedAt'),
        json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
      FROM json_each(?) WHERE ${guard}
      ON CONFLICT(playlist_id, song_id) DO UPDATE SET
        bucket = excluded.bucket, anomaly_type = excluded.anomaly_type,
        last_seen_at = excluded.last_seen_at, last_confirmed_at = excluded.last_confirmed_at,
        last_playable_at = excluded.last_playable_at, confirmed_at = excluded.confirmed_at,
        updated_at = excluded.updated_at`
    ).bind(playlistId, JSON.stringify(plan.managedSongUpserts), playlistId,
      bindingVersion, batchId, bindingVersion),
    db.prepare(`UPDATE sync_playlist_tasks SET status = 'success', phase = 'complete',
      observed_at = ?, current_song_count = ?, new_count = ?, confirmed_missing_count = ?,
      confirmed_grey_count = ?, auto_recovered_count = ?, completed_at = ?,
      error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND playlist_id = ? AND status = 'running' AND binding_version = ?
        AND EXISTS (SELECT 1 FROM instance_config WHERE id = 'primary'
          AND binding_version = ? AND status = 'ready')`
    ).bind(plan.observedAt, plan.result.currentSongCount, plan.result.newCount,
      plan.result.confirmedMissingCount, plan.result.confirmedGreyCount,
      plan.result.autoRecoveredCount, new Date().toISOString(), batchId,
      playlistId, bindingVersion, bindingVersion),
  ];
  const results = await db.batch(statements);
  const failed = results.find((item) => !item.success);
  if (failed) throw new Error(failed.error || "D1 rejected playlist sync");
  if ((results[2].meta?.changes ?? 0) !== 1) throw new Error("Playlist binding changed during sync");
}

export async function completeSongEverywhere(db: D1DatabasePort, songId: string,
  bindingVersion: number, accountUid: string,
): Promise<"completed" | "normal" | "not_found" | "binding_changed" | "sync_in_progress"> {
  const guard = `EXISTS (SELECT 1 FROM instance_config WHERE id = 'primary'
    AND binding_version = ? AND account_uid = ? AND status = 'ready')
    AND NOT EXISTS (SELECT 1 FROM sync_batches WHERE status IN ('queued', 'running'))
    AND NOT EXISTS (SELECT 1 FROM pending_playlist_sets WHERE status IN ('preparing', 'running'))`;
  const results = await db.batch([
    db.prepare(`DELETE FROM playlist_song_states WHERE song_id = ? AND bucket = 'anomaly'
      AND ${guard}`).bind(songId, bindingVersion, accountUid),
    db.prepare(`DELETE FROM songs WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM playlist_song_states WHERE song_id = ?) AND ${guard}`)
      .bind(songId, songId, bindingVersion, accountUid),
  ]);
  const failed = results.find((item) => !item.success);
  if (failed) throw new Error(failed.error || "Could not complete song");
  if ((results[0].meta?.changes ?? 0) > 0) return "completed";
  const currentVersion = await db.prepare(`SELECT binding_version, account_uid
    FROM instance_config WHERE id = 'primary'`).first<{
      binding_version: number; account_uid: string | null;
    }>();
  if (currentVersion?.binding_version !== bindingVersion ||
    currentVersion.account_uid !== accountUid) return "binding_changed";
  const active = await db.prepare(`SELECT 1 AS active WHERE
    EXISTS (SELECT 1 FROM sync_batches WHERE status IN ('queued', 'running'))
    OR EXISTS (SELECT 1 FROM pending_playlist_sets WHERE status IN ('preparing', 'running'))`)
    .first<{ active: number }>();
  if (active) return "sync_in_progress";
  const row = await db.prepare(`SELECT bucket FROM playlist_song_states WHERE song_id = ? LIMIT 1`)
    .bind(songId).first<{ bucket: string }>();
  return row ? "normal" : "not_found";
}

export interface MultiRecoveryRow {
  songId: string; type: "missing" | "grey"; title: string; artists: string[];
  album: string | null; coverUrl: string | null; neteaseUrl: string;
  lastNormalAt: string | null; contexts: Array<{ playlistId: string; playlistName: string; type: "missing" | "grey" }>;
}

export async function listMultiRecovery(db: D1DatabasePort, options: {
  type?: "missing" | "grey"; playlistId?: string; query?: string; offset?: number; limit?: number;
} = {}): Promise<{ items: MultiRecoveryRow[]; nextOffset: number | null; total: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 40));
  const offset = Math.max(0, options.offset ?? 0);
  const query = `%${(options.query ?? "").trim()}%`;
  const filter = `s.bucket = 'anomaly' AND (? IS NULL OR s.anomaly_type = ?)
    AND (? IS NULL OR s.playlist_id = ?)`;
  const [page, count] = await Promise.all([
    db.prepare(`SELECT songs.id AS song_id, songs.title, songs.artists, songs.album,
      songs.cover_url, songs.netease_url,
      (SELECT CASE WHEN SUM(x.anomaly_type = 'missing') > 0 THEN 'missing' ELSE 'grey' END
       FROM playlist_song_states x WHERE x.song_id = songs.id AND x.bucket = 'anomaly') AS type,
      (SELECT MIN(x.last_playable_at) FROM playlist_song_states x WHERE x.song_id = songs.id
       AND x.bucket = 'anomaly' AND x.last_playable_at IS NOT NULL) AS last_normal_at,
      (SELECT json_group_array(json_object('playlistId', z.playlist_id,
        'playlistName', z.name, 'type', z.anomaly_type))
       FROM (SELECT x.playlist_id, p.name, x.anomaly_type FROM playlist_song_states x
         JOIN monitored_playlists p ON p.id = x.playlist_id
         WHERE x.song_id = songs.id AND x.bucket = 'anomaly'
         ORDER BY p.list_order, p.id) z) AS contexts
      FROM songs WHERE EXISTS (SELECT 1 FROM playlist_song_states s WHERE s.song_id = songs.id
        AND ${filter})
        AND (? = '%%' OR songs.title LIKE ? OR songs.artists LIKE ? OR COALESCE(songs.album, '') LIKE ?)
      ORDER BY (SELECT MAX(x.confirmed_at) FROM playlist_song_states x
        WHERE x.song_id = songs.id AND x.bucket = 'anomaly') DESC, songs.id DESC
      LIMIT ? OFFSET ?`).bind(options.type ?? null, options.type ?? null,
        options.playlistId ?? null, options.playlistId ?? null,
        query, query, query, query, limit + 1, offset).all<{
          song_id: string; title: string; artists: string; album: string | null;
          cover_url: string | null; netease_url: string; type: "missing" | "grey";
          last_normal_at: string | null; contexts: string;
        }>(),
    db.prepare(`SELECT COUNT(*) AS total FROM songs WHERE EXISTS (
      SELECT 1 FROM playlist_song_states s WHERE s.song_id = songs.id AND ${filter})
      AND (? = '%%' OR songs.title LIKE ? OR songs.artists LIKE ? OR COALESCE(songs.album, '') LIKE ?)`)
      .bind(options.type ?? null, options.type ?? null, options.playlistId ?? null,
        options.playlistId ?? null, query, query, query, query).first<{ total: number }>(),
  ]);
  if (!page.success) throw new Error(page.error || "Could not load recovery");
  const found = page.results ?? [];
  return {
    items: found.slice(0, limit).map((row) => ({
      songId: row.song_id, type: row.type, title: row.title,
      artists: JSON.parse(row.artists), album: row.album, coverUrl: row.cover_url,
      neteaseUrl: row.netease_url, lastNormalAt: row.last_normal_at,
      contexts: JSON.parse(row.contexts),
    })),
    nextOffset: found.length > limit ? offset + limit : null,
    total: Number(count?.total ?? 0),
  };
}

export async function listPlaylistSongs(db: D1DatabasePort, playlistId: string, options: {
  query?: string; offset?: number; limit?: number;
} = {}) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 40));
  const offset = Math.max(0, options.offset ?? 0);
  const query = `%${(options.query ?? "").trim()}%`;
  const [page, count] = await Promise.all([
    db.prepare(`SELECT songs.id, songs.title, songs.artists, songs.album,
      songs.cover_url, songs.netease_url, s.first_seen_at, s.last_seen_at,
      s.last_confirmed_at,
      CASE WHEN s.bucket = 'anomaly' THEN s.anomaly_type ELSE 'playable' END AS state
      FROM playlist_song_states s JOIN songs ON songs.id = s.song_id
      WHERE s.playlist_id = ? AND (? = '%%' OR songs.title LIKE ? OR songs.artists LIKE ?
        OR COALESCE(songs.album, '') LIKE ?)
      ORDER BY s.last_seen_at DESC, songs.id DESC LIMIT ? OFFSET ?`)
      .bind(playlistId, query, query, query, query, limit + 1, offset).all<{
        id: string; title: string; artists: string; album: string | null;
        cover_url: string | null; netease_url: string; first_seen_at: string;
        last_seen_at: string; last_confirmed_at: string; state: string;
      }>(),
    db.prepare(`SELECT COUNT(*) AS total FROM playlist_song_states s JOIN songs ON songs.id = s.song_id
      WHERE s.playlist_id = ? AND (? = '%%' OR songs.title LIKE ? OR songs.artists LIKE ?
        OR COALESCE(songs.album, '') LIKE ?)`).bind(playlistId, query, query, query, query)
      .first<{ total: number }>(),
  ]);
  if (!page.success) throw new Error(page.error || "Could not load playlist songs");
  const found = page.results ?? [];
  return {
    items: found.slice(0, limit).map((row) => ({
      id: row.id, title: row.title, artists: JSON.parse(row.artists), album: row.album,
      coverUrl: row.cover_url, neteaseUrl: row.netease_url,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
      lastConfirmedAt: row.last_confirmed_at, state: row.state,
    })),
    nextOffset: found.length > limit ? offset + limit : null,
    total: Number(count?.total ?? 0),
  };
}
