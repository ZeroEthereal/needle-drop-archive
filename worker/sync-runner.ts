import { NeteaseClient, NeteaseError, type LoginStatus } from "../lib/netease";
import {
  recordSyncFailure,
  runSnapshotSync,
  startSyncRun,
  updateSyncRunPhase,
  loadSyncState,
  BindingChangedError,
  type CompletePlaylistSnapshot,
  type SyncTrigger,
} from "../lib/sync";
import type { Env } from "./env";
import { ensureInstanceConfig } from "./instance-config";
import {
  loadNeteaseSession,
  markNeteaseSessionStatus,
  storeNeteaseSessionIfBindingCurrent,
} from "./session-store";
import { verifySnapshotAnomalies } from "./snapshot-verifier";

export interface MusicSyncResult {
  runId: string;
  currentSongCount: number;
  newCount: number;
  confirmedMissingCount: number;
  confirmedGreyCount: number;
  autoRecoveredCount: number;
}

function loginStateError(state: LoginStatus["state"]): NeteaseError {
  if (state === "anonymous") return new NeteaseError("anonymous", "网易云账号接口返回匿名登录态，请重新扫码连接。");
  if (state === "expired") return new NeteaseError("session_expired", "网易云登录态已经过期，请重新扫码连接。");
  if (state === "risk_controlled") return new NeteaseError("risk_control", "网易云账号校验触发风控，本次同步已停止，请稍后重试。");
  return new NeteaseError("invalid_response", "网易云账号校验没有返回有效资料。");
}

export function snapshotForStateMachine(account: Awaited<ReturnType<NeteaseClient["getAccountSnapshot"]>>): CompletePlaylistSnapshot {
  return {
    observedAt: account.capturedAt,
    declaredTrackCount: account.trackIds.length,
    complete: true,
    songs: account.songs.map((item) => ({
      id: item.id,
      title: item.song.title,
      artists: item.song.artists.map((artist) => artist.name),
      album: item.song.album.name,
      coverUrl: item.song.album.coverUrl,
      neteaseUrl: item.song.neteaseUrl,
      accountPlayable: item.playable,
    })),
  };
}

function errorInfo(error: unknown): {
  code: string;
  message: string;
  phase: string;
  reauthRequired: boolean;
} {
  if (error instanceof NeteaseError) {
    const reauthRequired = error.kind === "authentication" ||
      error.kind === "anonymous" ||
      error.kind === "session_expired" ||
      error.kind === "uid_mismatch";
    return {
      code: `NETEASE_${error.kind.toUpperCase()}`,
      message: error.message,
      phase: reauthRequired ? "validate_session" : "fetch_snapshot",
      reauthRequired,
    };
  }
  const message = error instanceof Error ? error.message : "Unknown sync error";
  return {
    code: "SYNC_FAILED",
    message,
    phase: "commit",
    reauthRequired: false,
  };
}

export async function runMusicSync(env: Env, trigger: SyncTrigger): Promise<MusicSyncResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const config = await ensureInstanceConfig(env);
  if (config.status !== "ready" || !config.accountUid || !config.playlistId) {
    throw new NeteaseError("authentication", "请先连接网易云并选择要监控的歌单。");
  }
  const bindingVersion = config.bindingVersion;
  await startSyncRun(env.DB, { runId, trigger, startedAt, bindingVersion });

  try {
    const stored = await loadNeteaseSession(env);
    if (!stored || stored.status === "reauth_required" || stored.status === "revoked") {
      throw new NeteaseError("authentication", "网易云登录态不存在或需要重新授权。");
    }

    const client = new NeteaseClient();
    let login = await client.getLoginStatus(stored.session);
    let refreshed = false;
    if (login.state === "anonymous" || login.state === "expired") {
      const refresh = await client.refreshSession(stored.session);
      refreshed = refresh.status === "refreshed";
      login = refresh.login;
    }
    if (login.state !== "valid" || !login.profile) {
      throw loginStateError(login.state);
    }
    if (login.profile.userId !== config.accountUid) {
      throw new NeteaseError("uid_mismatch", "当前网易云登录态与实例绑定账号不一致。");
    }

    // Persist any refreshed cookies before the snapshot. No old workflow writes
    // the primary session after its version-guarded state commit.
    const sessionStillCurrent = await storeNeteaseSessionIfBindingCurrent(
      env,
      stored.session,
      login.profile.userId,
      bindingVersion,
      {
      validated: true,
      refreshed,
      },
    );
    if (!sessionStillCurrent) throw new BindingChangedError();

    await updateSyncRunPhase(env.DB, runId, "fetch_snapshot");
    const state = await loadSyncState(env.DB);
    const account = await client.getAccountSnapshot(stored.session, {
      playlistId: config.playlistId,
      expectedUserId: config.accountUid,
      strictCompleteness: true,
    });
    const verifiedAccount = await verifySnapshotAnomalies(
      client,
      stored.session,
      account,
      state,
    );
    await updateSyncRunPhase(env.DB, runId, "compare_and_commit");
    const { plan } = await runSnapshotSync(env.DB, snapshotForStateMachine(verifiedAccount), {
      trigger,
      runId,
      startedAt,
      bindingVersion,
      state,
    });

    return {
      runId,
      currentSongCount: plan.result.currentSongCount,
      newCount: plan.result.newCount,
      confirmedMissingCount: plan.result.confirmedMissingCount,
      confirmedGreyCount: plan.result.confirmedGreyCount,
      autoRecoveredCount: plan.result.autoRecoveredCount,
    };
  } catch (error) {
    if (error instanceof BindingChangedError) throw error;
    const info = errorInfo(error);
    if (info.reauthRequired) {
      await markNeteaseSessionStatus(env, "reauth_required").catch(() => undefined);
    }
    await recordSyncFailure(env.DB, {
      runId,
      trigger,
      status: info.reauthRequired ? "reauth_required" : "failed",
      phase: info.phase,
      startedAt,
      errorCode: info.code,
      errorMessage: info.message,
    });
    throw error;
  }
}
