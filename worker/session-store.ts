import {
  deserializeNeteaseSession,
  serializeNeteaseSession,
  type NeteaseSession,
} from "../lib/netease";
import type { Env } from "./env";
import { decryptSecret, encryptSecret } from "./secrets";

export type StoredSessionStatus = "valid" | "unknown" | "reauth_required" | "revoked";

interface StoredSessionRow {
  ciphertext: string;
  nonce: string;
  key_version: number;
  uid: string;
  status: StoredSessionStatus;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  last_refreshed_at: string | null;
}

export interface LoadedNeteaseSession {
  session: NeteaseSession;
  uid: string;
  status: StoredSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastRefreshedAt: string | null;
}

function validSessionId(id: string): string {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new TypeError("Invalid session id");
  return id;
}

export async function loadNeteaseSession(
  env: Env,
  id = "primary",
): Promise<LoadedNeteaseSession | null> {
  const row = await env.DB.prepare(`
    SELECT ciphertext, nonce, key_version, uid, status, created_at, updated_at,
           last_validated_at, last_refreshed_at
    FROM netease_sessions WHERE id = ? LIMIT 1
  `).bind(validSessionId(id)).first<StoredSessionRow>();
  if (!row) return null;

  const serialized = await decryptSecret(
    { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version },
    env,
  );
  return {
    session: deserializeNeteaseSession(serialized),
    uid: row.uid,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

export async function storeNeteaseSession(
  env: Env,
  session: NeteaseSession,
  uid: string,
  options: {
    id?: string;
    status?: StoredSessionStatus;
    validated?: boolean;
    refreshed?: boolean;
  } = {},
): Promise<void> {
  const encrypted = await encryptSecret(serializeNeteaseSession(session), env);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    INSERT INTO netease_sessions (
      id, ciphertext, nonce, algorithm, key_version, uid, status,
      created_at, updated_at, last_validated_at, last_refreshed_at
    ) VALUES (?, ?, ?, 'AES-256-GCM', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      nonce = excluded.nonce,
      algorithm = excluded.algorithm,
      key_version = excluded.key_version,
      uid = excluded.uid,
      status = excluded.status,
      updated_at = excluded.updated_at,
      last_validated_at = COALESCE(excluded.last_validated_at, netease_sessions.last_validated_at),
      last_refreshed_at = COALESCE(excluded.last_refreshed_at, netease_sessions.last_refreshed_at)
  `)
    .bind(
      validSessionId(options.id ?? "primary"),
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.keyVersion,
      uid,
      options.status ?? "valid",
      now,
      now,
      options.validated ? now : null,
      options.refreshed ? now : null,
    )
    .run();
  if (!result.success) throw new Error(result.error || "Could not store NetEase session");
}

export async function storeNeteaseSessionIfBindingCurrent(
  env: Env,
  session: NeteaseSession,
  uid: string,
  bindingVersion: number,
  options: { validated?: boolean; refreshed?: boolean } = {},
): Promise<boolean> {
  const encrypted = await encryptSecret(serializeNeteaseSession(session), env);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE netease_sessions SET
      ciphertext = ?, nonce = ?, algorithm = 'AES-256-GCM', key_version = ?,
      uid = ?, status = 'valid', updated_at = ?,
      last_validated_at = CASE WHEN ? = 1 THEN ? ELSE last_validated_at END,
      last_refreshed_at = CASE WHEN ? = 1 THEN ? ELSE last_refreshed_at END
    WHERE id = 'primary' AND EXISTS (
      SELECT 1 FROM instance_config
      WHERE id = 'primary' AND binding_version = ? AND account_uid = ? AND status = 'ready'
    )
  `).bind(
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.keyVersion,
    uid,
    now,
    options.validated ? 1 : 0,
    now,
    options.refreshed ? 1 : 0,
    now,
    bindingVersion,
    uid,
  ).run();
  if (!result.success) throw new Error(result.error || "Could not refresh NetEase session");
  return (result.meta?.changes ?? 0) === 1;
}

export async function markNeteaseSessionStatus(
  env: Env,
  status: StoredSessionStatus,
  validated = false,
): Promise<void> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE netease_sessions
    SET status = ?, updated_at = ?,
        last_validated_at = CASE WHEN ? = 1 THEN ? ELSE last_validated_at END
    WHERE id = 'primary'
  `).bind(status, now, validated ? 1 : 0, now).run();
  if (!result.success) throw new Error(result.error || "Could not update NetEase session status");
}

export async function revokeNeteaseSession(env: Env): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM netease_sessions WHERE id = 'primary'").run();
  if (!result.success) throw new Error(result.error || "Could not revoke NetEase session");
}

export async function deleteNeteaseSession(env: Env, id: string): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM netease_sessions WHERE id = ?")
    .bind(validSessionId(id))
    .run();
  if (!result.success) throw new Error(result.error || "Could not delete NetEase session");
}

export async function getNeteaseSessionHealth(env: Env): Promise<{
  state: "not_connected" | StoredSessionStatus;
  uid: string | null;
  lastValidatedAt: string | null;
}> {
  const row = await env.DB.prepare(`
    SELECT uid, status, last_validated_at FROM netease_sessions WHERE id = 'primary' LIMIT 1
  `).first<{ uid: string; status: StoredSessionStatus; last_validated_at: string | null }>();
  return row
    ? { state: row.status, uid: row.uid, lastValidatedAt: row.last_validated_at }
    : { state: "not_connected", uid: null, lastValidatedAt: null };
}
