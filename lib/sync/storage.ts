import type { D1DatabasePort } from "./repository";

export type NeteaseSessionStatus =
  | "valid"
  | "unknown"
  | "reauth_required"
  | "revoked";

export interface EncryptedNeteaseSession {
  ciphertext: string;
  nonce: string;
  algorithm: "AES-256-GCM";
  keyVersion: number;
  uid: string;
  status: NeteaseSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastRefreshedAt: string | null;
}

interface SessionDbRow {
  ciphertext: string;
  nonce: string;
  algorithm: "AES-256-GCM";
  key_version: number;
  uid: string;
  status: NeteaseSessionStatus;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  last_refreshed_at: string | null;
}

export async function getNeteaseSession(
  db: D1DatabasePort,
): Promise<EncryptedNeteaseSession | null> {
  const row = await db
    .prepare(`
      SELECT ciphertext, nonce, algorithm, key_version, uid, status, created_at,
             updated_at, last_validated_at, last_refreshed_at
      FROM netease_sessions WHERE id = 'primary'
    `)
    .first<SessionDbRow>();
  if (!row) return null;
  return {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    algorithm: row.algorithm,
    keyVersion: row.key_version,
    uid: row.uid,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

export async function putNeteaseSession(
  db: D1DatabasePort,
  input: Omit<EncryptedNeteaseSession, "createdAt" | "updatedAt">,
): Promise<void> {
  const result = await db
    .prepare(`
      INSERT INTO netease_sessions (
        id, ciphertext, nonce, algorithm, key_version, uid, status,
        last_validated_at, last_refreshed_at, created_at, updated_at
      ) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        algorithm = excluded.algorithm,
        key_version = excluded.key_version,
        uid = excluded.uid,
        status = excluded.status,
        last_validated_at = excluded.last_validated_at,
        last_refreshed_at = excluded.last_refreshed_at,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      input.ciphertext,
      input.nonce,
      input.algorithm,
      input.keyVersion,
      input.uid,
      input.status,
      input.lastValidatedAt,
      input.lastRefreshedAt,
    )
    .run();
  if (!result.success) throw new Error(result.error ?? "Could not save NetEase session");
}

export async function setNeteaseSessionStatus(
  db: D1DatabasePort,
  status: NeteaseSessionStatus,
  validatedAt: string | null = null,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE netease_sessions
      SET status = ?, last_validated_at = COALESCE(?, last_validated_at),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 'primary'
    `)
    .bind(status, validatedAt)
    .run();
  if (!result.success) throw new Error(result.error ?? "Could not update NetEase session");
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteNeteaseSession(db: D1DatabasePort): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM netease_sessions WHERE id = 'primary'`).run();
  if (!result.success) throw new Error(result.error ?? "Could not delete NetEase session");
  return (result.meta?.changes ?? 0) > 0;
}

export async function getSetting<T>(
  db: D1DatabasePort,
  key: string,
): Promise<T | null> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function putSetting(
  db: D1DatabasePort,
  key: string,
  value: unknown,
): Promise<void> {
  const result = await db
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .bind(key, JSON.stringify(value))
    .run();
  if (!result.success) throw new Error(result.error ?? "Could not save setting");
}
