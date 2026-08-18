import type { ManagedSongState, SyncPlan, SyncState } from "./state-machine";

export interface D1ResultPort<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; [key: string]: unknown };
  error?: string;
}

export interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1PreparedStatementPort;
  all<T = Record<string, unknown>>(): Promise<D1ResultPort<T>>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultPort<T>>;
}

export interface D1DatabasePort {
  prepare(query: string): D1PreparedStatementPort;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementPort[],
  ): Promise<D1ResultPort<T>[]>;
}

interface ManagedSongDbRow {
  song_id: string;
  bucket: "normal" | "anomaly";
  anomaly_type: "missing" | "grey" | null;
  first_seen_at: string;
  last_seen_at: string;
  last_playable_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rows<T>(result: D1ResultPort<T>): T[] {
  if (!result.success) throw new Error(result.error ?? "D1 query failed");
  return result.results ?? [];
}

export async function loadSyncState(db: D1DatabasePort): Promise<SyncState> {
  const result = await db.prepare(`
    SELECT song_id, bucket, anomaly_type, first_seen_at, last_seen_at,
           last_playable_at, confirmed_at, created_at, updated_at
    FROM managed_songs
  `).all<ManagedSongDbRow>();

  return {
    managedSongs: rows(result).map((row): ManagedSongState => ({
      songId: row.song_id,
      bucket: row.bucket,
      anomalyType: row.anomaly_type,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastPlayableAt: row.last_playable_at,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

const UPSERT_SONGS_SQL = `
  INSERT INTO songs (
    id, title, artists, album, cover_url, netease_url, created_at, updated_at
  )
  SELECT
    json_extract(value, '$.id'),
    json_extract(value, '$.title'),
    json_extract(value, '$.artists'),
    json_extract(value, '$.album'),
    json_extract(value, '$.coverUrl'),
    json_extract(value, '$.neteaseUrl'),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM json_each(?)
  WHERE true
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    artists = excluded.artists,
    album = excluded.album,
    cover_url = excluded.cover_url,
    netease_url = excluded.netease_url,
    updated_at = CURRENT_TIMESTAMP
`;

const UPSERT_MANAGED_SONGS_SQL = `
  INSERT INTO managed_songs (
    song_id, bucket, anomaly_type, first_seen_at, last_seen_at,
    last_playable_at, confirmed_at, created_at, updated_at
  )
  SELECT
    json_extract(value, '$.songId'),
    json_extract(value, '$.bucket'),
    json_extract(value, '$.anomalyType'),
    json_extract(value, '$.firstSeenAt'),
    json_extract(value, '$.lastSeenAt'),
    json_extract(value, '$.lastPlayableAt'),
    json_extract(value, '$.confirmedAt'),
    json_extract(value, '$.createdAt'),
    json_extract(value, '$.updatedAt')
  FROM json_each(?)
  WHERE true
  ON CONFLICT(song_id) DO UPDATE SET
    bucket = excluded.bucket,
    anomaly_type = excluded.anomaly_type,
    first_seen_at = excluded.first_seen_at,
    last_seen_at = excluded.last_seen_at,
    last_playable_at = excluded.last_playable_at,
    confirmed_at = excluded.confirmed_at,
    updated_at = excluded.updated_at
`;

export type SyncTrigger = "scheduled" | "manual";

export interface CommitSyncOptions {
  runId: string;
  trigger: SyncTrigger;
  startedAt: string;
  bindingVersion: number;
}

export class BindingChangedError extends Error {
  constructor() {
    super("Playlist binding changed while the sync was running");
    this.name = "BindingChangedError";
  }
}

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("Another music sync is already running");
    this.name = "SyncAlreadyRunningError";
  }
}

export async function startSyncRun(
  db: D1DatabasePort,
  options: CommitSyncOptions,
  phase = "validate_session",
): Promise<void> {
  const staleBefore = new Date(new Date(options.startedAt).getTime() - 15 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT INTO sync_runs (
      id, trigger, status, phase, started_at, binding_version, created_at, updated_at
    )
    SELECT ?, ?, 'running', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs
      WHERE id <> ? AND status = 'running' AND started_at >= ?
    )
      AND EXISTS (
        SELECT 1 FROM instance_config
        WHERE id = 'primary' AND binding_version = ? AND status = 'ready'
      )
    ON CONFLICT(id) DO UPDATE SET
      status = 'running', phase = excluded.phase, started_at = excluded.started_at,
      completed_at = NULL, error_code = NULL, error_message = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    options.runId,
    options.trigger,
    phase,
    options.startedAt,
    options.bindingVersion,
    options.runId,
    staleBefore,
    options.bindingVersion,
  ).run();
  if (!result.success) throw new Error(result.error ?? "Could not start sync run");
  if (result.meta?.changes === 0) throw new SyncAlreadyRunningError();
}

export async function updateSyncRunPhase(
  db: D1DatabasePort,
  runId: string,
  phase: string,
): Promise<void> {
  const result = await db.prepare(`
    UPDATE sync_runs SET phase = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `).bind(phase, runId).run();
  if (!result.success) throw new Error(result.error ?? "Could not update sync phase");
}

/** Commits the complete state transition and successful run record atomically. */
export async function commitSyncPlan(
  db: D1DatabasePort,
  plan: SyncPlan,
  options: CommitSyncOptions,
): Promise<void> {
  const statements: D1PreparedStatementPort[] = [
    db.prepare(UPSERT_SONGS_SQL.replace(
      "WHERE true",
      "WHERE EXISTS (SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND status = 'ready')",
    )).bind(JSON.stringify(plan.songUpserts), options.bindingVersion),
  ];
  if (plan.managedSongUpserts.length > 0) {
    statements.push(
      db.prepare(UPSERT_MANAGED_SONGS_SQL.replace(
        "WHERE true",
        "WHERE EXISTS (SELECT 1 FROM instance_config WHERE id = 'primary' AND binding_version = ? AND status = 'ready')",
      )).bind(JSON.stringify(plan.managedSongUpserts), options.bindingVersion),
    );
  }

  statements.push(
    db.prepare(`
      INSERT INTO sync_runs (
        id, trigger, status, phase, observed_at, shanghai_date, started_at,
        completed_at, current_song_count, new_count, confirmed_missing_count,
        confirmed_grey_count, auto_recovered_count,
        created_at, updated_at
      )
      SELECT ?, ?, 'success', 'complete', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      WHERE EXISTS (
        SELECT 1 FROM instance_config
        WHERE id = 'primary' AND binding_version = ? AND status = 'ready'
      )
      ON CONFLICT(id) DO UPDATE SET
        trigger = excluded.trigger,
        status = 'success',
        phase = 'complete',
        observed_at = excluded.observed_at,
        shanghai_date = excluded.shanghai_date,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        current_song_count = excluded.current_song_count,
        new_count = excluded.new_count,
        confirmed_missing_count = excluded.confirmed_missing_count,
        confirmed_grey_count = excluded.confirmed_grey_count,
        auto_recovered_count = excluded.auto_recovered_count,
        error_code = NULL,
        error_message = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      options.runId,
      options.trigger,
      plan.observedAt,
      plan.shanghaiDate,
      options.startedAt,
      new Date().toISOString(),
      plan.result.currentSongCount,
      plan.result.newCount,
      plan.result.confirmedMissingCount,
      plan.result.confirmedGreyCount,
      plan.result.autoRecoveredCount,
      options.bindingVersion,
    ),
    db.prepare(`
      DELETE FROM sync_runs
      WHERE id NOT IN (
        SELECT id FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 30
      )
    `),
  );

  const results = await db.batch(statements);
  const failed = results.find((result) => !result.success);
  if (failed) throw new Error(failed.error ?? "D1 rejected the sync transaction");
  const successResult = results[results.length - 2];
  if ((successResult.meta?.changes ?? 0) === 0) throw new BindingChangedError();
}

export interface RecordFailureInput {
  runId: string;
  trigger: SyncTrigger;
  status?: "failed" | "reauth_required";
  phase: string;
  startedAt: string;
  completedAt?: string;
  errorCode: string;
  errorMessage: string;
}

/** Records diagnostics only; it never changes songs or managed song state. */
export async function recordSyncFailure(
  db: D1DatabasePort,
  input: RecordFailureInput,
): Promise<void> {
  const results = await db.batch([
    db.prepare(`
      INSERT INTO sync_runs (
        id, trigger, status, phase, started_at, completed_at, error_code,
        error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        trigger = excluded.trigger,
        status = excluded.status,
        phase = excluded.phase,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      input.runId,
      input.trigger,
      input.status ?? "failed",
      input.phase,
      input.startedAt,
      input.completedAt ?? new Date().toISOString(),
      input.errorCode,
      input.errorMessage.slice(0, 1000),
    ),
    db.prepare(`
      DELETE FROM sync_runs
      WHERE id NOT IN (
        SELECT id FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 30
      )
    `),
  ]);
  const failed = results.find((result) => !result.success);
  if (failed) throw new Error(failed.error ?? "Could not record failed sync");
}

export type CompleteManagedSongResult = "completed" | "normal" | "not_found";

export async function completeManagedSong(
  db: D1DatabasePort,
  songId: string,
): Promise<CompleteManagedSongResult> {
  if (!songId.trim()) return "not_found";

  // Deleting the parent song removes its managed_songs row through ON DELETE CASCADE.
  // The EXISTS guard makes a stale page incapable of deleting a row already restored to normal.
  const result = await db.prepare(`
    DELETE FROM songs
    WHERE id = ?
      AND EXISTS (
        SELECT 1 FROM managed_songs
        WHERE managed_songs.song_id = songs.id AND bucket = 'anomaly'
      )
  `).bind(songId).run();
  if (!result.success) throw new Error(result.error ?? "Could not complete managed song");
  if ((result.meta?.changes ?? 0) > 0) return "completed";

  const current = await db.prepare(`
    SELECT bucket FROM managed_songs WHERE song_id = ?
  `).bind(songId).first<{ bucket: "normal" | "anomaly" }>();
  return current?.bucket === "normal" ? "normal" : "not_found";
}

export interface RecoveryListRow {
  songId: string;
  type: "missing" | "grey";
  title: string;
  artists: string[];
  album: string | null;
  coverUrl: string | null;
  neteaseUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastNormalAt: string | null;
  confirmedAt: string;
}

interface RecoveryListDbRow {
  song_id: string;
  type: "missing" | "grey";
  title: string;
  artists: string;
  album: string | null;
  cover_url: string | null;
  netease_url: string;
  first_seen_at: string;
  last_seen_at: string;
  last_normal_at: string | null;
  confirmed_at: string;
}

export async function listOpenRecovery(
  db: D1DatabasePort,
  options: { type?: "missing" | "grey"; query?: string; offset?: number; limit?: number } = {},
): Promise<{ items: RecoveryListRow[]; nextOffset: number | null }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 40));
  const offset = Math.max(0, options.offset ?? 0);
  const query = `%${(options.query ?? "").trim()}%`;
  const type = options.type ?? null;
  const result = await db.prepare(`
    SELECT m.song_id, m.anomaly_type AS type, s.title, s.artists, s.album,
           s.cover_url, s.netease_url, m.first_seen_at, m.last_seen_at,
           m.last_playable_at AS last_normal_at, m.confirmed_at
    FROM managed_songs m
    JOIN songs s ON s.id = m.song_id
    WHERE m.bucket = 'anomaly'
      AND (? IS NULL OR m.anomaly_type = ?)
      AND (? = '%%' OR s.title LIKE ? OR s.artists LIKE ? OR COALESCE(s.album, '') LIKE ?)
    ORDER BY m.confirmed_at DESC, m.song_id DESC
    LIMIT ? OFFSET ?
  `).bind(type, type, query, query, query, query, limit + 1, offset).all<RecoveryListDbRow>();
  const found = rows(result);
  const hasMore = found.length > limit;
  return {
    items: found.slice(0, limit).map((row) => ({
      songId: row.song_id,
      type: row.type,
      title: row.title,
      artists: JSON.parse(row.artists) as string[],
      album: row.album,
      coverUrl: row.cover_url,
      neteaseUrl: row.netease_url,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastNormalAt: row.last_normal_at,
      confirmedAt: row.confirmed_at,
    })),
    nextOffset: hasMore ? offset + limit : null,
  };
}

export interface LikeListRow {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  coverUrl: string | null;
  neteaseUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  state: "playable" | "grey" | "missing";
}

interface LikeListDbRow {
  id: string;
  title: string;
  artists: string;
  album: string | null;
  cover_url: string | null;
  netease_url: string;
  first_seen_at: string;
  last_seen_at: string;
  state: "playable" | "grey" | "missing";
}

export async function listCurrentLikes(
  db: D1DatabasePort,
  options: { query?: string; offset?: number; limit?: number } = {},
): Promise<{ items: LikeListRow[]; nextOffset: number | null; total: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 40));
  const offset = Math.max(0, options.offset ?? 0);
  const query = `%${(options.query ?? "").trim()}%`;
  const [listResult, countRow] = await Promise.all([
    db.prepare(`
      SELECT s.id, s.title, s.artists, s.album, s.cover_url, s.netease_url,
             m.first_seen_at, m.last_seen_at,
             CASE
               WHEN m.bucket = 'anomaly' THEN m.anomaly_type
               ELSE 'playable'
             END AS state
      FROM managed_songs m
      JOIN songs s ON s.id = m.song_id
      WHERE (? = '%%' OR s.title LIKE ? OR s.artists LIKE ? OR COALESCE(s.album, '') LIKE ?)
      ORDER BY m.last_seen_at DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).bind(query, query, query, query, limit + 1, offset).all<LikeListDbRow>(),
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM managed_songs m
      JOIN songs s ON s.id = m.song_id
      WHERE (? = '%%' OR s.title LIKE ? OR s.artists LIKE ? OR COALESCE(s.album, '') LIKE ?)
    `).bind(query, query, query, query).first<{ total: number }>(),
  ]);
  const found = rows(listResult);
  const hasMore = found.length > limit;
  return {
    items: found.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      artists: JSON.parse(row.artists) as string[],
      album: row.album,
      coverUrl: row.cover_url,
      neteaseUrl: row.netease_url,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      state: row.state,
    })),
    nextOffset: hasMore ? offset + limit : null,
    total: Number(countRow?.total ?? 0),
  };
}

export interface SyncOverview {
  state: "idle" | "running" | "success" | "failed" | "reauth_required";
  phase: string | null;
  lastSuccessAt: string | null;
  totalSongCount: number;
  normalCount: number;
  missingCount: number;
  greyCount: number;
  error: string | null;
}

interface SyncOverviewDbRow {
  status: "running" | "success" | "failed" | "reauth_required";
  phase: string | null;
  error_message: string | null;
}

interface ManagedCountsDbRow {
  total_count: number | null;
  normal_count: number | null;
  missing_count: number | null;
  grey_count: number | null;
}

export async function getSyncOverview(db: D1DatabasePort): Promise<SyncOverview> {
  const [latest, lastSuccess, counts] = await Promise.all([
    db.prepare(`
      SELECT status, phase, error_message
      FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 1
    `).first<SyncOverviewDbRow>(),
    db.prepare(`
      SELECT completed_at FROM sync_runs
      WHERE status = 'success' ORDER BY started_at DESC, id DESC LIMIT 1
    `).first<{ completed_at: string | null }>(),
    db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN bucket = 'normal' THEN 1 ELSE 0 END) AS normal_count,
        SUM(CASE WHEN bucket = 'anomaly' AND anomaly_type = 'missing' THEN 1 ELSE 0 END) AS missing_count,
        SUM(CASE WHEN bucket = 'anomaly' AND anomaly_type = 'grey' THEN 1 ELSE 0 END) AS grey_count
      FROM managed_songs
    `).first<ManagedCountsDbRow>(),
  ]);

  return {
    state: latest?.status ?? "idle",
    phase: latest?.phase ?? null,
    lastSuccessAt: lastSuccess?.completed_at ?? null,
    totalSongCount: Number(counts?.total_count ?? 0),
    normalCount: Number(counts?.normal_count ?? 0),
    missingCount: Number(counts?.missing_count ?? 0),
    greyCount: Number(counts?.grey_count ?? 0),
    error: latest?.error_message ?? null,
  };
}
