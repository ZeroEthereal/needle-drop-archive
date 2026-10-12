import type { PlaylistDetail } from "../lib/netease";
import type { Env } from "./env";

export type InstanceStatus = "unconfigured" | "ready" | "rebinding" | "error";
export interface InstanceConfig {
  accountUid: string | null;
  accountNickname: string | null;
  accountAvatarUrl: string | null;
  bindingVersion: number;
  status: InstanceStatus;
  boundAt: string | null;
}
export async function getInstanceConfig(env: Env): Promise<InstanceConfig> {
  const row = await env.DB.prepare(`SELECT account_uid, account_nickname, account_avatar_url,
    binding_version, status, bound_at FROM instance_config WHERE id = 'primary' LIMIT 1`).first<{
      account_uid: string | null; account_nickname: string | null; account_avatar_url: string | null;
      binding_version: number; status: InstanceStatus; bound_at: string | null;
    }>();
  if (!row) throw new Error("instance_config singleton is missing; apply D1 migrations");
  return { accountUid: row.account_uid, accountNickname: row.account_nickname,
    accountAvatarUrl: row.account_avatar_url, bindingVersion: Number(row.binding_version),
    status: row.status, boundAt: row.bound_at };
}
export function playlistPublicMetadata(playlist: PlaylistDetail, accountUid: string) {
  return { id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl,
    trackCount: playlist.trackCount, ownerUid: playlist.userId, ownerName: playlist.ownerName,
    owned: playlist.userId === accountUid, private: playlist.privacy !== null && playlist.privacy !== 0,
    specialType: playlist.specialType };
}
