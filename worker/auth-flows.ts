import { NeteaseClient, serializeNeteaseSession, type NeteaseProfile } from "../lib/netease";
import QRCode from "qrcode";
import type { Env } from "./env";
import { getInstanceConfig } from "./instance-config";
import { decryptSecret, encryptSecret } from "./secrets";
import {
  loadNeteaseSession,
} from "./session-store";

export type AuthFlowMode = "initial" | "reauthorize";

interface AuthFlowRow {
  id: string;
  mode: AuthFlowMode;
  challenge_ciphertext: string;
  challenge_nonce: string;
  challenge_key_version: number;
  status: "waiting_scan" | "waiting_confirm" | "authorized" | "expired" | "cancelled" | "error";
  session_id: string | null;
  account_uid: string | null;
  account_nickname: string | null;
  account_avatar_url: string | null;
  expires_at: string;
}

export interface PublicAuthFlow {
  id: string;
  mode: AuthFlowMode;
  state: AuthFlowRow["status"] | "same_account_authorized";
  qrImageUrl?: string;
  expiresAt: string;
  profile?: NeteaseProfile;
  requiresPlaylistSelection?: boolean;
}

async function cleanupExpiredFlows(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(`
    SELECT session_id FROM netease_auth_flows
    WHERE expires_at <= ? AND status IN ('waiting_scan', 'waiting_confirm', 'authorized')
  `).bind(now).all<{ session_id: string | null }>();
  const sessionIds = (expired.results ?? [])
    .map((row) => row.session_id)
    .filter((id): id is string => Boolean(id && id !== "primary"));
  const statements = [
    env.DB.prepare(`
      DELETE FROM pending_playlist_bindings
      WHERE status = 'failed' AND auth_flow_id IN (
        SELECT id FROM netease_auth_flows WHERE expires_at <= ?
      )
    `).bind(now),
    env.DB.prepare(`
      DELETE FROM netease_auth_flows
      WHERE expires_at <= ? AND NOT EXISTS (
        SELECT 1 FROM pending_playlist_bindings
        WHERE pending_playlist_bindings.auth_flow_id = netease_auth_flows.id
      )
    `).bind(now),
    ...sessionIds.map((id) => env.DB.prepare(`
      DELETE FROM netease_sessions WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM pending_playlist_bindings WHERE session_id = ?)
    `).bind(id, id)),
  ];
  const results = await env.DB.batch(statements);
  const failed = results.find((result) => !result.success);
  if (failed) throw new Error(failed.error || "Could not expire NetEase auth flows");
}

export async function createAuthFlow(env: Env, requestedMode?: AuthFlowMode): Promise<PublicAuthFlow> {
  await cleanupExpiredFlows(env);
  const config = await getInstanceConfig(env);
  const mode = requestedMode ?? (config.status === "ready" ? "reauthorize" : "initial");
  if (mode === "initial" && config.status !== "unconfigured") {
    throw new Error("INSTANCE_ALREADY_CONFIGURED");
  }
  if (mode === "reauthorize" && config.status === "unconfigured") {
    throw new Error("INSTANCE_NOT_CONFIGURED");
  }

  const challenge = await new NeteaseClient().createQrLogin();
  const encrypted = await encryptSecret(challenge.key, env);
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`
    INSERT INTO netease_auth_flows (
      id, mode, challenge_ciphertext, challenge_nonce, challenge_key_version,
      status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'waiting_scan', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    id,
    mode,
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.keyVersion,
    challenge.expiresAt,
  ).run();
  if (!result.success) throw new Error(result.error || "Could not create NetEase auth flow");
  return {
    id,
    mode,
    state: "waiting_scan",
    qrImageUrl: `/api/netease/auth-flows/${id}/qr`,
    expiresAt: challenge.expiresAt,
  };
}

async function authFlow(env: Env, id: string): Promise<AuthFlowRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return env.DB.prepare(`
    SELECT id, mode, challenge_ciphertext, challenge_nonce, challenge_key_version,
           status, session_id, account_uid, account_nickname, account_avatar_url, expires_at
    FROM netease_auth_flows WHERE id = ? LIMIT 1
  `).bind(id).first<AuthFlowRow>();
}

export async function authFlowQrSvg(env: Env, id: string): Promise<string | null> {
  const flow = await authFlow(env, id);
  if (!flow || Date.parse(flow.expires_at) <= Date.now() ||
      (flow.status !== "waiting_scan" && flow.status !== "waiting_confirm")) {
    return null;
  }
  const key = await decryptSecret({
    ciphertext: flow.challenge_ciphertext,
    nonce: flow.challenge_nonce,
    keyVersion: flow.challenge_key_version,
  }, env);
  const qrUrl = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
  return QRCode.toString(qrUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 560,
    color: { dark: "#100b1b", light: "#fffaff" },
  });
}

export async function pollAuthFlow(env: Env, id: string): Promise<PublicAuthFlow | null> {
  const flow = await authFlow(env, id);
  if (!flow) return null;
  if (Date.parse(flow.expires_at) <= Date.now()) {
    const statements = [env.DB.prepare("DELETE FROM netease_auth_flows WHERE id = ?").bind(id)];
    if (flow.session_id && flow.session_id !== "primary") {
      statements.push(env.DB.prepare("DELETE FROM netease_sessions WHERE id = ?").bind(flow.session_id));
    }
    const expired = await env.DB.batch(statements);
    const failed = expired.find((item) => !item.success);
    if (failed) throw new Error(failed.error || "Could not expire NetEase auth flow");
    return { id, mode: flow.mode, state: "expired", expiresAt: flow.expires_at };
  }
  if (flow.status === "authorized") {
    return {
      id,
      mode: flow.mode,
      state: "authorized",
      expiresAt: flow.expires_at,
      profile: flow.account_uid ? {
        userId: flow.account_uid,
        nickname: flow.account_nickname ?? "网易云用户",
        avatarUrl: flow.account_avatar_url,
      } : undefined,
      requiresPlaylistSelection: flow.session_id !== "primary",
    };
  }
  if (flow.status === "expired" || flow.status === "cancelled" || flow.status === "error") {
    return { id, mode: flow.mode, state: flow.status, expiresAt: flow.expires_at };
  }

  const key = await decryptSecret({
    ciphertext: flow.challenge_ciphertext,
    nonce: flow.challenge_nonce,
    keyVersion: flow.challenge_key_version,
  }, env);
  const result = await new NeteaseClient().checkQrLogin(key);
  if (result.state !== "authorized") {
    await env.DB.prepare(`UPDATE netease_auth_flows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(result.state, id).run();
    return { id, mode: flow.mode, state: result.state, expiresAt: flow.expires_at };
  }
  if (!result.profile || !result.session) throw new Error("INCOMPLETE_QR_AUTH");

  const config = await getInstanceConfig(env);
  const isSameAccount = config.status === "ready" && config.accountUid === result.profile.userId;
  const sessionId = isSameAccount ? "primary" : `pending:${id}`;
  const now = new Date().toISOString();
  const encryptedSession = await encryptSecret(serializeNeteaseSession(result.session), env);
  const statements = [
    env.DB.prepare(`
      INSERT INTO netease_sessions (
        id, ciphertext, nonce, algorithm, key_version, uid, status,
        created_at, updated_at, last_validated_at, last_refreshed_at
      ) VALUES (?, ?, ?, 'AES-256-GCM', ?, ?, 'valid', ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        ciphertext = excluded.ciphertext, nonce = excluded.nonce,
        algorithm = excluded.algorithm, key_version = excluded.key_version,
        uid = excluded.uid, status = 'valid', updated_at = excluded.updated_at,
        last_validated_at = excluded.last_validated_at
    `).bind(
      sessionId,
      encryptedSession.ciphertext,
      encryptedSession.nonce,
      encryptedSession.keyVersion,
      result.profile.userId,
      now,
      now,
      now,
    ),
    env.DB.prepare(`
      UPDATE netease_auth_flows SET
        status = 'authorized', session_id = ?, account_uid = ?, account_nickname = ?,
        account_avatar_url = ?, updated_at = ?
      WHERE id = ? AND status IN ('waiting_scan', 'waiting_confirm')
    `).bind(sessionId, result.profile.userId, result.profile.nickname, result.profile.avatarUrl, now, id),
  ];
  if (isSameAccount) {
    statements.push(env.DB.prepare(`
      UPDATE instance_config SET account_nickname = ?, account_avatar_url = ?, updated_at = ?
      WHERE id = 'primary' AND account_uid = ?
    `).bind(result.profile.nickname, result.profile.avatarUrl, now, result.profile.userId));
  }
  const updates = await env.DB.batch(statements);
  const failed = updates.find((item) => !item.success);
  if (failed) throw new Error(failed.error || "Could not finish NetEase authorization");
  if (isSameAccount) {
    await env.DB.prepare("DELETE FROM netease_auth_flows WHERE id = ?").bind(id).run();
  }
  return {
    id,
    mode: flow.mode,
    state: isSameAccount ? "same_account_authorized" : "authorized",
    expiresAt: flow.expires_at,
    profile: result.profile,
    requiresPlaylistSelection: !isSameAccount,
  };
}

export async function sessionForPlaylistRequest(env: Env, flowId?: string) {
  if (!flowId) {
    const session = await loadNeteaseSession(env);
    return session ? { ...session, flowId: null } : null;
  }
  const flow = await authFlow(env, flowId);
  if (!flow || flow.status !== "authorized" || !flow.session_id || Date.parse(flow.expires_at) <= Date.now()) {
    return null;
  }
  const session = await loadNeteaseSession(env, flow.session_id);
  return session ? { ...session, flowId } : null;
}

export async function cancelAuthFlow(env: Env, id: string): Promise<boolean> {
  const flow = await authFlow(env, id);
  if (!flow) return false;
  const activeBinding = flow.session_id
    ? await env.DB.prepare(`
        SELECT id FROM pending_playlist_bindings WHERE session_id = ? LIMIT 1
      `).bind(flow.session_id).first<{ id: string }>()
    : null;
  if (activeBinding) return false;
  const statements = [
    env.DB.prepare("DELETE FROM netease_auth_flows WHERE id = ?").bind(id),
  ];
  if (flow.session_id && flow.session_id !== "primary") {
    statements.push(env.DB.prepare("DELETE FROM netease_sessions WHERE id = ?").bind(flow.session_id));
  }
  const results = await env.DB.batch(statements);
  const failed = results.find((result) => !result.success);
  if (failed) throw new Error(failed.error || "Could not cancel NetEase auth flow");
  return true;
}
