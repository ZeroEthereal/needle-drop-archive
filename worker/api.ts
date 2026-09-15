import { Hono } from "hono";
import { NeteaseClient, NeteaseError } from "../lib/netease";
import {
  getSetting,
  getSyncOverview,
  putSetting,
} from "../lib/sync";
import { AccessDeniedError, assertSameOriginMutation, requireAccessIdentity } from "./access";
import type { Env } from "./env";
import {
  getNeteaseSessionHealth,
} from "./session-store";
import {
  authFlowQrSvg,
  cancelAuthFlow,
  createAuthFlow,
  pollAuthFlow,
  sessionForPlaylistRequest,
  type AuthFlowMode,
} from "./auth-flows";
import { ensureInstanceConfig, getInstanceConfig, playlistPublicMetadata } from "./instance-config";
import {
  completeSongEverywhere, defaultPlaylist, listMonitoredPlaylists,
  listMultiRecovery, listPlaylistSongs,
} from "../lib/sync/multi-repository";
import { createSyncBatch, latestBatchStatus, latestCompletedBatch } from "./sync-batches";
import type { PlaylistSelection } from "./playlist-set-binding";

const QR_CREATE_COOLDOWN_MS = 5_000;
const MANUAL_SYNC_PENDING_MS = 15 * 60 * 1_000;

interface ApiVariables {
  accessEmail: string;
}

interface QrRateLimit {
  createdAt: string;
}

interface ManualSyncQueue {
  id: string;
  requestedAt: string;
}

interface LatestSyncRun {
  status: "running" | "success" | "failed" | "reauth_required";
  started_at: string;
  completed_at: string | null;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const app = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message }, code, message },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function positiveInteger(value: string | null, fallback: number, field: string): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ApiError(400, "INVALID_PAGINATION", `${field} 必须是非负整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(400, "INVALID_PAGINATION", `${field} 超出支持范围。`);
  }
  return parsed;
}

function pagination(url: URL): { offset: number; limit: number } {
  const offset = positiveInteger(url.searchParams.get("cursor") ?? url.searchParams.get("offset"), 0, "cursor");
  const requestedLimit = positiveInteger(url.searchParams.get("limit"), 40, "limit");
  return { offset, limit: Math.min(100, Math.max(1, requestedLimit)) };
}

function searchQuery(url: URL): string | undefined {
  const query = url.searchParams.get("query")?.trim();
  if (!query) return undefined;
  if (query.length > 200) throw new ApiError(400, "QUERY_TOO_LONG", "搜索内容不能超过 200 个字符。");
  return query;
}

function nextCursor(offset: number | null): string | null {
  return offset === null ? null : String(offset);
}

async function jsonBody(context: { req: { json<T>(): Promise<T> } }): Promise<Record<string, unknown>> {
  try {
    const body = await context.req.json<unknown>();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "INVALID_JSON", "请求内容必须是 JSON 对象。");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "请求内容不是有效的 JSON。");
  }
}

function optionalFlowId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new ApiError(400, "INVALID_AUTH_FLOW", "登录流程 ID 无效。");
  }
  return value;
}

function requiredNumericId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{1,24}$/.test(value)) {
    throw new ApiError(400, "INVALID_ID", `${field} 无效。`);
  }
  return value;
}

function nextShanghaiRun(now = new Date()): string {
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();
  let nextRun = new Date(Date.UTC(year, month, day, -5, 17));
  if (nextRun.getTime() <= now.getTime()) {
    nextRun = new Date(Date.UTC(year, month, day + 1, -5, 17));
  }
  return nextRun.toISOString();
}

async function safeSetting<T>(env: Env, key: string): Promise<T | null> {
  try {
    return await getSetting<T>(env.DB, key);
  } catch {
    return null;
  }
}

async function latestSyncRun(env: Env): Promise<LatestSyncRun | null> {
  return env.DB.prepare(`
    SELECT status, started_at, completed_at
    FROM sync_runs
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `).first<LatestSyncRun>();
}

function queueIsPending(queue: ManualSyncQueue | null, latest: LatestSyncRun | null, now = Date.now()): boolean {
  if (!queue) return false;
  const requestedAt = Date.parse(queue.requestedAt);
  if (!Number.isFinite(requestedAt) || now - requestedAt > MANUAL_SYNC_PENDING_MS) return false;
  if (!latest) return true;
  const latestStartedAt = Date.parse(latest.started_at);
  return !Number.isFinite(latestStartedAt) || latestStartedAt < requestedAt;
}

function publicSessionState(state: Awaited<ReturnType<typeof getNeteaseSessionHealth>>["state"]):
  "valid" | "anonymous" | "expired" | "unknown" {
  if (state === "valid") return "valid";
  if (state === "reauth_required") return "expired";
  if (state === "not_connected" || state === "revoked") return "anonymous";
  return "unknown";
}

app.use("/api/*", async (context, next) => {
  const identity = await requireAccessIdentity(context.req.raw, context.env);
  assertSameOriginMutation(context.req.raw);

  context.set("accessEmail", identity.email);

  await next();
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
});

app.options("/api/*", (context) => context.body(null, 204));

app.get("/api/recovery", async (context) => {
  const url = new URL(context.req.url);
  const { offset, limit } = pagination(url);
  const requestedType = url.searchParams.get("type");
  if (requestedType && requestedType !== "all" && requestedType !== "missing" && requestedType !== "grey") {
    throw new ApiError(400, "INVALID_RECOVERY_TYPE", "type 只能是 missing 或 grey。");
  }
  const type = requestedType === "missing" || requestedType === "grey" ? requestedType : undefined;
  const requestedPlaylist = url.searchParams.get("playlistId");
  const monitored = await listMonitoredPlaylists(context.env.DB);
  if (requestedPlaylist && requestedPlaylist !== "all" && !monitored.some((p) => p.id === requestedPlaylist))
    throw new ApiError(400, "INVALID_PLAYLIST", "所选歌单未受监控。");
  const page = await listMultiRecovery(context.env.DB, {
    type,
    playlistId: requestedPlaylist && requestedPlaylist !== "all" ? requestedPlaylist : undefined,
    query: searchQuery(url),
    offset,
    limit,
  });
  return context.json({
    items: page.items,
    nextCursor: nextCursor(page.nextOffset),
    total: page.total,
  });
});

app.post("/api/recovery/:songId/complete", async (context) => {
  const songId = context.req.param("songId").trim();
  if (!songId || songId.length > 200) {
    throw new ApiError(400, "INVALID_SONG_ID", "歌曲 ID 无效。");
  }
  const config = await getInstanceConfig(context.env);
  if (!config.accountUid || config.status !== "ready")
    throw new ApiError(409, "INSTANCE_NOT_CONFIGURED", "尚未连接网易账号。");
  const result = await completeSongEverywhere(context.env.DB, songId,
    config.bindingVersion, config.accountUid);
  if (result === "binding_changed")
    throw new ApiError(409, "BINDING_CHANGED", "监控歌单已变化，请刷新后重试。");
  if (result === "sync_in_progress")
    throw new ApiError(409, "SYNC_IN_PROGRESS", "同步或调整歌单期间暂不能完成歌曲，请稍后重试。");
  if (result === "normal") {
    return context.json({ completed: false, restored: true, songId });
  }
  if (result === "not_found") {
    throw new ApiError(404, "MANAGED_SONG_NOT_FOUND", "这首歌不存在或已经处理。");
  }
  return context.json({ completed: true, restored: false, songId });
});

app.get("/api/likes", async (context) => {
  const url = new URL(context.req.url);
  const { offset, limit } = pagination(url);
  const playlists = await listMonitoredPlaylists(context.env.DB);
  const playlistId = url.searchParams.get("playlistId") ?? defaultPlaylist(playlists)?.id;
  if (!playlistId || !playlists.some((playlist) => playlist.id === playlistId))
    throw new ApiError(400, "PLAYLIST_NOT_MONITORED", "请选择一个已监控歌单。");
  const page = await listPlaylistSongs(context.env.DB, playlistId, {
    query: searchQuery(url),
    offset,
    limit,
  });
  return context.json({
    items: page.items,
    nextCursor: nextCursor(page.nextOffset),
    total: page.total,
    playlistId,
  });
});

app.get("/api/sync/status", async (context) => {
  const [overview, session, config, latest, queue, pending, playlists, batch, recoveryCounts, playlistTasks, completedBatch, lastBatchSuccess] = await Promise.all([
    getSyncOverview(context.env.DB),
    getNeteaseSessionHealth(context.env),
    ensureInstanceConfig(context.env),
    latestSyncRun(context.env),
    safeSetting<ManualSyncQueue>(context.env, "manual_sync_queue"),
    context.env.DB.prepare(`
      SELECT id, status, error_code, error_message, workflow_id, created_at, updated_at
      FROM pending_playlist_sets ORDER BY created_at DESC LIMIT 1
    `).first<{
      id: string;
      status: "preparing" | "running" | "failed";
      error_code: string | null;
      error_message: string | null;
      workflow_id: string | null;
      created_at: string;
      updated_at: string;
    }>(),
    listMonitoredPlaylists(context.env.DB),
    latestBatchStatus(context.env),
    context.env.DB.prepare(`SELECT COUNT(DISTINCT song_id) AS total,
      COUNT(DISTINCT CASE WHEN anomaly_type = 'grey' THEN song_id END) AS grey,
      COUNT(DISTINCT CASE WHEN anomaly_type = 'missing' THEN song_id END) AS missing
      FROM playlist_song_states WHERE bucket = 'anomaly'`)
      .first<{ total: number; grey: number; missing: number }>(),
    context.env.DB.prepare(`SELECT * FROM (
      SELECT t.*, ROW_NUMBER() OVER (PARTITION BY t.playlist_id
        ORDER BY datetime(b.created_at) DESC, b.id DESC) AS rank
      FROM sync_playlist_tasks t JOIN sync_batches b ON b.id = t.batch_id)
      WHERE rank = 1`).all<Record<string, unknown>>(),
    latestCompletedBatch(context.env),
    context.env.DB.prepare(`SELECT completed_at FROM sync_batches
      WHERE status = 'success' AND scope = 'all'
      ORDER BY datetime(completed_at) DESC, id DESC LIMIT 1`)
      .first<{ completed_at: string | null }>(),
  ]);

  const queued = batch?.batch.status === "queued" || queueIsPending(queue, latest);
  const sessionStatus = publicSessionState(session.state);
  const selected = defaultPlaylist(playlists);
  const batchState = batch?.batch.status as "queued" | "running" | "success" | "failed" | undefined;

  return context.json({
    ...overview,
    state: queued ? "queued" : batchState ?? (config.bindingVersion <= 1 ? overview.state : "idle"),
    phase: queued ? "queued" : batchState === "running"
      ? String(batch?.tasks.find((task) => task.playlist_id === batch.batch.current_playlist_id)?.phase ?? "validate_session")
      : overview.phase,
    nextRunAt: nextShanghaiRun(),
    progress: batch ? (Number(batch.batch.success_count) + Number(batch.batch.failure_count)) /
      Math.max(1, Number(batch.batch.playlist_count)) : undefined,
    lastSuccessAt: lastBatchSuccess?.completed_at ??
      (config.bindingVersion <= 1 ? overview.lastSuccessAt : null),
    error: batchState === "failed"
      ? String(batch?.tasks.find((task) => task.status === "failed")?.error_message ??
        batch?.batch.error_message ?? "部分歌单没有完成同步。")
      : null,
    sessionStatus,
    session: {
      state: sessionStatus,
      uid: session.uid,
      lastValidatedAt: session.lastValidatedAt,
    },
    setupState: config.status,
    bindingVersion: config.bindingVersion,
    profile: config.accountUid ? {
      userId: config.accountUid,
      nickname: config.accountNickname ?? "网易云用户",
      avatarUrl: config.accountAvatarUrl,
      connectedAt: config.boundAt,
    } : null,
    playlist: selected ? {
      id: selected.id,
      name: selected.name,
      coverUrl: selected.coverUrl,
      ownerUid: selected.ownerUid,
      ownerName: selected.ownerName,
      owned: selected.owned,
      boundAt: selected.boundAt,
    } : null,
    playlists: playlists.map((item) => ({
      id: item.id, name: item.name, coverUrl: item.coverUrl,
      ownerUid: item.ownerUid, ownerName: item.ownerName, owned: item.owned,
      specialType: item.specialType, listOrder: item.listOrder,
      boundAt: item.boundAt, totalSongCount: item.totalSongCount,
      normalCount: item.normalCount, missingCount: item.missingCount,
      greyCount: item.greyCount,
      task: playlistTasks.results?.find((task) => task.playlist_id === item.id) ?? null,
    })),
    batch: batch ? { ...batch.batch, tasks: batch.tasks } : null,
    completedBatch,
    manualSyncDisabled: batch?.batch.status === "queued" || batch?.batch.status === "running" ||
      pending?.status === "preparing" || pending?.status === "running",
    recoveryTotal: Number(recoveryCounts?.total ?? 0),
    recoveryGreyCount: Number(recoveryCounts?.grey ?? 0),
    recoveryMissingCount: Number(recoveryCounts?.missing ?? 0),
    binding: pending ? {
      id: pending.id,
      state: pending.status,
      workflowId: pending.workflow_id,
      error: pending.status === "failed" ? {
        code: pending.error_code ?? "BINDING_FAILED",
        message: pending.error_message ?? "新歌单读取失败，原歌单和历史未发生变化。",
      } : null,
      createdAt: pending.created_at,
      updatedAt: pending.updated_at,
    } : null,
  });
});

app.post("/api/sync", async (context) => {
  const config = await ensureInstanceConfig(context.env);
  if (config.status !== "ready" || !config.accountUid) {
    throw new ApiError(409, "INSTANCE_NOT_CONFIGURED", "请先连接网易云并选择要监控的歌单。");
  }
  const body = await jsonBody(context);
  const playlistId = body.playlistId === undefined ? undefined
    : requiredNumericId(body.playlistId, "歌单 ID");
  try {
    const batchId = await createSyncBatch(context.env, "manual", playlistId);
    return context.json({ state: "queued", batchId, playlistId: playlistId ?? null }, 202);
  } catch (error) {
    if (error instanceof Error && error.message === "SYNC_IN_PROGRESS")
      throw new ApiError(409, "SYNC_IN_PROGRESS", "已有同步正在进行，请等待当前任务完成。");
    if (error instanceof Error && error.message === "PLAYLIST_NOT_MONITORED")
      throw new ApiError(400, "PLAYLIST_NOT_MONITORED", "所选歌单未受监控。");
    throw error;
  }
});

app.post("/api/netease/auth-flows", async (context) => {
  const rateKey = `qr_rate:${context.get("accessEmail")}`;
  const previous = await safeSetting<QrRateLimit>(context.env, rateKey);
  const previousAt = previous ? Date.parse(previous.createdAt) : Number.NaN;
  if (Number.isFinite(previousAt) && Date.now() - previousAt < QR_CREATE_COOLDOWN_MS) {
    throw new ApiError(429, "QR_RATE_LIMITED", "二维码创建得太快，请几秒后再试。");
  }

  const body = await jsonBody(context);
  const requestedMode = body.mode === undefined ? undefined : body.mode;
  if (requestedMode !== undefined && requestedMode !== "initial" && requestedMode !== "reauthorize") {
    throw new ApiError(400, "INVALID_AUTH_MODE", "登录模式无效。");
  }
  let flow;
  try {
    flow = await createAuthFlow(context.env, requestedMode as AuthFlowMode | undefined);
  } catch (error) {
    if (error instanceof Error && error.message === "INSTANCE_ALREADY_CONFIGURED") {
      throw new ApiError(409, "INSTANCE_ALREADY_CONFIGURED", "实例已经绑定账号，请使用重新授权。");
    }
    if (error instanceof Error && error.message === "INSTANCE_NOT_CONFIGURED") {
      throw new ApiError(409, "INSTANCE_NOT_CONFIGURED", "实例尚未绑定账号，请先连接网易云。");
    }
    throw error;
  }
  await putSetting(context.env.DB, rateKey, { createdAt: new Date().toISOString() } satisfies QrRateLimit);
  return context.json(flow, 201);
});

app.post("/api/netease/auth-flows/:id/poll", async (context) => {
  const result = await pollAuthFlow(context.env, context.req.param("id"));
  if (!result) throw new ApiError(404, "AUTH_FLOW_NOT_FOUND", "登录流程不存在或已经清理。");
  return context.json(result);
});

app.get("/api/netease/auth-flows/:id/qr", async (context) => {
  const svg = await authFlowQrSvg(context.env, context.req.param("id"));
  if (!svg) throw new ApiError(404, "AUTH_FLOW_QR_NOT_FOUND", "二维码不存在或已经过期。");
  return context.body(svg, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store, private",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
  });
});

app.post("/api/netease/auth-flows/:id/cancel", async (context) => {
  const cancelled = await cancelAuthFlow(context.env, context.req.param("id"));
  if (!cancelled) throw new ApiError(409, "AUTH_FLOW_NOT_CANCELLABLE", "登录流程不存在或已经进入基线任务。");
  return context.json({ cancelled: true });
});

app.post("/api/netease/playlists", async (context) => {
  const body = await jsonBody(context);
  const flowId = optionalFlowId(body.flowId);
  const offset = typeof body.offset === "number" && Number.isSafeInteger(body.offset) && body.offset >= 0
    ? body.offset
    : 0;
  const limit = typeof body.limit === "number" && Number.isSafeInteger(body.limit)
    ? Math.min(100, Math.max(1, body.limit))
    : 50;
  const stored = await sessionForPlaylistRequest(context.env, flowId);
  if (!stored) throw new ApiError(401, "NETEASE_SESSION_REQUIRED", "网易云登录流程已失效，请重新扫码。");
  const page = await new NeteaseClient().getUserPlaylists(stored.uid, stored.session, offset, limit);
  return context.json({
    items: page.playlists.map((playlist) => playlistPublicMetadata(playlist, stored.uid)),
    nextOffset: page.hasMore ? offset + page.playlists.length : null,
    total: page.total,
    accountUid: stored.uid,
  });
});

app.post("/api/playlist-binding", async (context) => {
  const body = await jsonBody(context);
  const flowId = optionalFlowId(body.flowId);
  const freshBaseline = body.freshBaseline === true;
  const rawIds = body.playlistIds;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 20)
    throw new ApiError(400, "INVALID_PLAYLIST_COUNT", "请选择 1–20 个歌单。");
  const playlistIds = rawIds.map((id) => requiredNumericId(id, "歌单 ID"));
  if (new Set(playlistIds).size !== playlistIds.length)
    throw new ApiError(400, "DUPLICATE_PLAYLIST", "不能重复选择同一个歌单。");
  const stored = await sessionForPlaylistRequest(context.env, flowId);
  if (!stored) throw new ApiError(401, "NETEASE_SESSION_REQUIRED", "网易云登录流程已失效，请重新扫码。");
  const config = await ensureInstanceConfig(context.env);
  const existing = await context.env.DB.prepare(`
    SELECT id FROM pending_playlist_sets WHERE status IN ('preparing', 'running') LIMIT 1
  `).first<{ id: string }>();
  if (existing) throw new ApiError(409, "BINDING_IN_PROGRESS", "已有歌单正在建立基线，请等待它完成。");
  const activeBatch = await context.env.DB.prepare(`SELECT id FROM sync_batches
    WHERE status IN ('queued', 'running') LIMIT 1`).first<{ id: string }>();
  if (activeBatch) throw new ApiError(409, "SYNC_IN_PROGRESS", "同步期间不能调整监控歌单。");

  const client = new NeteaseClient();
  const accessible: Awaited<ReturnType<NeteaseClient["getUserPlaylists"]>>["playlists"] = [];
  let offset = 0;
  const pageSignatures = new Set<string>();
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await client.getUserPlaylists(stored.uid, stored.session, offset, 100);
    const signature = page.playlists.map((playlist) => playlist.id).join(",");
    if (pageSignatures.has(signature)) break;
    pageSignatures.add(signature);
    accessible.push(...page.playlists);
    if (playlistIds.every((id) => accessible.some((playlist) => playlist.id === id)) || !page.hasMore) break;
    if (page.playlists.length === 0) break;
    const nextOffset = offset + page.playlists.length;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }
  const selected = playlistIds.map((id) => accessible.find((playlist) => playlist.id === id));
  if (selected.some((playlist) => !playlist))
    throw new ApiError(404, "PLAYLIST_NOT_ACCESSIBLE", "所选歌单不全在当前账号可访问的列表中。");
  const monitored = await listMonitoredPlaylists(context.env.DB);
  const replacingAccount = config.accountUid !== stored.uid;
  if (freshBaseline && (flowId || replacingAccount || body.confirmedFreshBaseline !== true))
    throw new ApiError(400, "FRESH_BASELINE_CONFIRMATION_REQUIRED",
      "重新建立基线只适用于当前账号，且必须确认清空旧歌曲状态。");
  const oldIds = new Set(replacingAccount || freshBaseline ? [] : monitored.map((playlist) => playlist.id));
  if (selected.some((playlist) => playlist!.trackCount <= 0 && !oldIds.has(playlist!.id)))
    throw new ApiError(400, "EMPTY_PLAYLIST", "首次监控的歌单必须非空。");
  const removed = monitored.filter((playlist) => replacingAccount || !playlistIds.includes(playlist.id));
  if (removed.length > 0 && body.confirmedRemoval !== true)
    throw new ApiError(409, "REMOVAL_CONFIRMATION_REQUIRED",
      `取消监控会永久删除 ${removed.map((playlist) => playlist.name).join("、")} 的状态和历史，请确认。`);
  const selections: PlaylistSelection[] = selected.map((playlist) => ({
    id: playlist!.id, name: playlist!.name, coverUrl: playlist!.coverUrl,
    ownerUid: playlist!.userId, ownerName: playlist!.ownerName,
    owned: playlist!.userId === stored.uid, specialType: playlist!.specialType,
    listOrder: accessible.findIndex((entry) => entry.id === playlist!.id),
  })).sort((a, b) => a.listOrder - b.listOrder);

  const id = crypto.randomUUID();
  const sessionId = flowId ? `pending:${flowId}` : "primary";
  const inserted = await context.env.DB.prepare(`
    INSERT INTO pending_playlist_sets (
      id, auth_flow_id, session_id, account_uid, account_nickname, account_avatar_url,
      playlist_json, base_binding_version, status, workflow_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    id,
    flowId ?? null,
    sessionId,
    stored.uid,
    flowId ? (await context.env.DB.prepare("SELECT account_nickname FROM netease_auth_flows WHERE id = ?")
      .bind(flowId).first<{ account_nickname: string }>())?.account_nickname ?? "网易云用户" : config.accountNickname ?? "网易云用户",
    flowId ? (await context.env.DB.prepare("SELECT account_avatar_url FROM netease_auth_flows WHERE id = ?")
      .bind(flowId).first<{ account_avatar_url: string | null }>())?.account_avatar_url ?? null : config.accountAvatarUrl,
    JSON.stringify({ playlists: selections, freshBaseline }),
    config.bindingVersion,
    `binding-${id}`,
  ).run();
  if (!inserted.success) throw new Error(inserted.error || "Could not create playlist binding request");

  if (!context.env.MUSIC_BATCH) throw new Error("MUSIC_BATCH workflow binding is unavailable");
  try {
    await context.env.MUSIC_BATCH.create({ id: `binding-${id}`,
      params: { action: "bind_playlist_set", bindingId: id } });
  } catch (error) {
    await context.env.DB.prepare(`UPDATE pending_playlist_sets SET status = 'failed',
      error_code = 'WORKFLOW_DISPATCH_FAILED', error_message = ? WHERE id = ?`)
      .bind((error instanceof Error ? error.message : "Workflow 派发失败").slice(0, 500), id)
      .run().catch(() => undefined);
    throw error;
  }
  const workflowId = `binding-${id}`;
  return context.json({
    state: "preparing",
    bindingId: id,
    workflowId,
    playlists: selections,
  }, 202);
});

app.notFound(() => jsonError(404, "API_NOT_FOUND", "接口不存在。"));

app.onError((error) => {
  if (error instanceof ApiError) return jsonError(error.status, error.code, error.message);
  if (error instanceof AccessDeniedError) return jsonError(error.status, "ACCESS_DENIED", error.message);
  if (error instanceof NeteaseError) {
    const cause = error.cause;
    console.warn(JSON.stringify({
      event: "netease_request_error",
      kind: error.kind,
      endpoint: error.endpoint,
      status: error.status,
      apiCode: error.apiCode,
      retryable: error.retryable,
      causeName: cause instanceof Error ? cause.name : typeof cause,
      causeMessage: cause instanceof Error ? cause.message : null,
    }));
    const status = error.kind === "rate_limited"
      ? 429
      : error.kind === "authentication" ||
          error.kind === "anonymous" ||
          error.kind === "session_expired" ||
          error.kind === "uid_mismatch"
        ? 401
        : error.kind === "risk_control"
          ? 503
          : 502;
    return jsonError(status, `NETEASE_${error.kind.toUpperCase()}`, error.message);
  }
  return jsonError(500, "INTERNAL_ERROR", "服务暂时无法完成请求，请稍后再试。");
});

export default app;
