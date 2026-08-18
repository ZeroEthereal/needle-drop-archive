import { NeteaseClient, type NeteaseProfile, type PlaylistDetail } from "../lib/netease";
import type { Env } from "./env";
import { loadNeteaseSession } from "./session-store";

export type InstanceStatus = "unconfigured" | "ready" | "rebinding" | "error";

export interface InstanceConfig {
  accountUid: string | null;
  accountNickname: string | null;
  accountAvatarUrl: string | null;
  playlistId: string | null;
  playlistName: string | null;
  playlistCoverUrl: string | null;
  playlistOwnerUid: string | null;
  playlistOwnerName: string | null;
  playlistOwned: boolean;
  bindingVersion: number;
  status: InstanceStatus;
  boundAt: string | null;
}

interface InstanceConfigRow {
  account_uid: string | null;
  account_nickname: string | null;
  account_avatar_url: string | null;
  playlist_id: string | null;
  playlist_name: string | null;
  playlist_cover_url: string | null;
  playlist_owner_uid: string | null;
  playlist_owner_name: string | null;
  playlist_owned: number;
  binding_version: number;
  status: InstanceStatus;
  bound_at: string | null;
}

function fromRow(row: InstanceConfigRow): InstanceConfig {
  return {
    accountUid: row.account_uid,
    accountNickname: row.account_nickname,
    accountAvatarUrl: row.account_avatar_url,
    playlistId: row.playlist_id,
    playlistName: row.playlist_name,
    playlistCoverUrl: row.playlist_cover_url,
    playlistOwnerUid: row.playlist_owner_uid,
    playlistOwnerName: row.playlist_owner_name,
    playlistOwned: row.playlist_owned === 1,
    bindingVersion: Number(row.binding_version),
    status: row.status,
    boundAt: row.bound_at,
  };
}

export async function getInstanceConfig(env: Env): Promise<InstanceConfig> {
  const row = await env.DB.prepare(`
    SELECT account_uid, account_nickname, account_avatar_url, playlist_id,
           playlist_name, playlist_cover_url, playlist_owner_uid,
           playlist_owner_name, playlist_owned, binding_version, status, bound_at
    FROM instance_config WHERE id = 'primary' LIMIT 1
  `).first<InstanceConfigRow>();
  if (!row) throw new Error("instance_config singleton is missing; apply D1 migrations");
  return fromRow(row);
}

export async function ensureInstanceConfig(env: Env): Promise<InstanceConfig> {
  const current = await getInstanceConfig(env);
  if (current.status !== "unconfigured" || !env.NETEASE_EXPECTED_UID || !env.NETEASE_PLAYLIST_ID) {
    return current;
  }
  const storedProfile = await env.DB.prepare("SELECT value FROM settings WHERE key = 'netease_profile' LIMIT 1")
    .first<{ value: string }>();
  let profile: NeteaseProfile | null = null;
  if (storedProfile) {
    try {
      const value = JSON.parse(storedProfile.value) as Partial<NeteaseProfile>;
      if (value.userId === env.NETEASE_EXPECTED_UID) {
        profile = {
          userId: value.userId,
          nickname: typeof value.nickname === "string" ? value.nickname : "网易云用户",
          avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : null,
        };
      }
    } catch {
      // Invalid legacy metadata is ignored; the encrypted session remains untouched.
    }
  }
  let playlist: PlaylistDetail | null = null;
  const session = await loadNeteaseSession(env).catch(() => null);
  if (session) {
    const client = new NeteaseClient();
    if (!profile) {
      const login = await client.getLoginStatus(session.session).catch(() => null);
      profile = login?.state === "valid" ? login.profile : null;
    }
    playlist = await client.getPlaylistDetail(env.NETEASE_PLAYLIST_ID, session.session).catch(() => null);
  }
  return bootstrapLegacyInstanceConfig(env, profile, playlist);
}

export function playlistPublicMetadata(playlist: PlaylistDetail, accountUid: string) {
  return {
    id: playlist.id,
    name: playlist.name,
    coverUrl: playlist.coverUrl,
    trackCount: playlist.trackCount,
    ownerUid: playlist.userId,
    ownerName: playlist.ownerName,
    owned: playlist.userId === accountUid,
    private: playlist.privacy !== null && playlist.privacy !== 0,
  };
}

/** Legacy bridge for the current private instance. It never deletes historical rows. */
export async function bootstrapLegacyInstanceConfig(
  env: Env,
  profile: NeteaseProfile | null,
  playlist: PlaylistDetail | null,
): Promise<InstanceConfig> {
  const current = await getInstanceConfig(env);
  if (current.status !== "unconfigured" || !env.NETEASE_EXPECTED_UID || !env.NETEASE_PLAYLIST_ID) {
    return current;
  }
  const uid = profile?.userId ?? env.NETEASE_EXPECTED_UID;
  const now = new Date().toISOString();
  const results = await env.DB.batch([env.DB.prepare(`
    UPDATE instance_config SET
      account_uid = ?, account_nickname = ?, account_avatar_url = ?,
      playlist_id = ?, playlist_name = ?, playlist_cover_url = ?,
      playlist_owner_uid = ?, playlist_owner_name = ?, playlist_owned = ?,
      binding_version = 1, status = 'ready', bound_at = ?, updated_at = ?
    WHERE id = 'primary' AND status = 'unconfigured'
  `).bind(
    uid,
    profile?.nickname ?? "网易云用户",
    profile?.avatarUrl ?? null,
    env.NETEASE_PLAYLIST_ID,
    playlist?.name ?? "已绑定歌单",
    playlist?.coverUrl ?? null,
    playlist?.userId ?? uid,
    playlist?.ownerName ?? profile?.nickname ?? "网易云用户",
    (playlist?.userId ?? uid) === uid ? 1 : 0,
    now,
    now,
  ), env.DB.prepare("DELETE FROM settings WHERE key = 'netease_profile'")]);
  const failed = results.find((result) => !result.success);
  if (failed) throw new Error(failed.error || "Could not migrate legacy instance config");
  return getInstanceConfig(env);
}
