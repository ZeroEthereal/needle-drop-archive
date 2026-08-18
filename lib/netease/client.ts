import { NeteaseError } from "./errors.ts";
import {
  createNeteaseSession,
  mergeSessionSetCookies,
  NeteaseSession,
  readSetCookieHeaders,
  sessionCookieHeader,
  sessionHasAuthentication,
} from "./session.ts";
import type {
  AccountSnapshot,
  AccountSnapshotOptions,
  AlbumSummary,
  ArtistSummary,
  CloudSong,
  CloudSongPage,
  LoginStatus,
  NeteaseClientOptions,
  NeteaseProfile,
  PlaybackAvailability,
  PlaylistDetail,
  PlaylistPage,
  QrLoginChallenge,
  RefreshResult,
  SongDetailBatch,
  SongSummary,
} from "./types.ts";

// NetEase's API host is reachable from Cloudflare Workers, while the public
// website host can reject edge-network subrequests at the network layer.
// Human-facing links intentionally continue to use music.163.com.
const DEFAULT_BASE_URL = "https://interface.music.163.com";
const ALLOWED_BASE_URLS = new Set([
  "https://music.163.com",
  "https://interface.music.163.com",
]);

interface JsonRecord {
  [key: string]: unknown;
}

interface RequestResult {
  body: JsonRecord;
  setCookies: string[];
}

export interface QrLoginCheckResult {
  state: "waiting_scan" | "waiting_confirm" | "authorized" | "expired";
  profile: NeteaseProfile | null;
  /** Opaque and JSON-redacted. Persist only through serializeNeteaseSession + encryption. */
  session?: NeteaseSession;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function apiCode(body: JsonRecord): number | null {
  const value = body.code;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function toSongId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, "");
  return null;
}

function requireSongId(value: string | number, field = "song id"): string {
  const id = toSongId(value);
  if (!id) throw new TypeError(`${field} must be a non-negative integer string`);
  return id;
}

function uniqueSongIds(ids: readonly (string | number)[]): string[] {
  return [...new Set(ids.map((id) => requireSongId(id)))];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIso(value: unknown): string | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeArtists(value: unknown): ArtistSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((artist): ArtistSummary[] => {
    if (!isRecord(artist)) return [];
    const name = toStringOrNull(artist.name);
    if (!name) return [];
    return [{ id: toSongId(artist.id), name }];
  });
}

function normalizeAlbum(value: unknown): AlbumSummary {
  if (!isRecord(value)) return { id: null, name: null, coverUrl: null };
  return {
    id: toSongId(value.id),
    name: toStringOrNull(value.name),
    coverUrl: toStringOrNull(value.picUrl) ?? toStringOrNull(value.coverUrl),
  };
}

function normalizeSong(value: unknown): SongSummary | null {
  if (!isRecord(value)) return null;
  const id = toSongId(value.id ?? value.songId);
  if (!id) return null;
  const title = toStringOrNull(value.name) ?? toStringOrNull(value.songName) ?? `未知歌曲 (${id})`;
  return {
    id,
    title,
    artists: normalizeArtists(value.ar ?? value.artists),
    album: normalizeAlbum(value.al ?? value.album),
    durationMs: toInteger(value.dt ?? value.duration),
    fee: toInteger(value.fee),
    copyright: toInteger(value.copyright),
    neteaseUrl: `https://music.163.com/song?id=${encodeURIComponent(id)}`,
  };
}

function normalizeCloudSong(value: unknown): CloudSong | null {
  if (!isRecord(value)) return null;
  const simpleSong = normalizeSong(value.simpleSong);
  const id = toSongId(value.songId) ?? simpleSong?.id ?? null;
  if (!id) return null;

  const artistText = toStringOrNull(value.artist);
  const albumText = toStringOrNull(value.album);
  const title = toStringOrNull(value.songName) ?? simpleSong?.title ?? `未知云盘歌曲 (${id})`;
  return {
    id,
    title,
    artists: simpleSong?.artists.length
      ? simpleSong.artists
      : artistText
        ? [{ id: null, name: artistText }]
        : [],
    album: simpleSong?.album.name
      ? simpleSong.album
      : { id: null, name: albumText, coverUrl: simpleSong?.album.coverUrl ?? null },
    fileName: toStringOrNull(value.fileName),
    addedAt: toIso(value.addTime),
    simpleSong,
  };
}

function cloudSongAsSummary(song: CloudSong): SongSummary {
  if (song.simpleSong) return song.simpleSong;
  return {
    id: song.id,
    title: song.title,
    artists: song.artists,
    album: song.album,
    durationMs: null,
    fee: null,
    copyright: null,
    neteaseUrl: `https://music.163.com/song?id=${encodeURIComponent(song.id)}`,
  };
}

function assertApiSuccess(body: JsonRecord, endpoint: string): void {
  const code = apiCode(body);
  if (code === 200) return;
  if (code === 301 || code === 302) {
    throw new NeteaseError("authentication", "NetEase authentication is required or expired", {
      endpoint,
      apiCode: code,
    });
  }
  if (code === 250 || code === 509 || code === 512) {
    throw new NeteaseError("risk_control", "NetEase rejected the request through account risk control", {
      endpoint,
      apiCode: code,
    });
  }
  throw new NeteaseError("api", "NetEase returned an unsuccessful application code", {
    endpoint,
    apiCode: code ?? undefined,
    retryable: code === 429 || (code !== null && code >= 500),
  });
}

function loginStateError(state: LoginStatus["state"]): NeteaseError {
  if (state === "anonymous") {
    return new NeteaseError("anonymous", "NetEase account endpoint returned an anonymous session", {
      endpoint: "/api/nuser/account/get",
    });
  }
  if (state === "expired") {
    return new NeteaseError("session_expired", "NetEase session has expired", {
      endpoint: "/api/nuser/account/get",
    });
  }
  if (state === "risk_controlled") {
    return new NeteaseError("risk_control", "NetEase rejected account validation through risk control", {
      endpoint: "/api/nuser/account/get",
    });
  }
  return new NeteaseError("invalid_response", "NetEase account validation did not yield a profile", {
    endpoint: "/api/nuser/account/get",
  });
}

function cookieHeaderFromSetCookie(setCookies: string[]): string {
  return setCookies
    .map((header) => header.split(";", 1)[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function playbackReason(value: JsonRecord, playable: boolean): PlaybackAvailability["reason"] {
  if (playable) return "playable";
  const code = toInteger(value.code);
  if (code === 404) return "not_found";
  if (code === 401 || code === 403) return "account_restricted";
  const fee = toInteger(value.fee);
  if (fee === 1 || fee === 4) return "payment_required";
  if (code === 200 && !(typeof value.url === "string" && value.url.length > 0)) return "no_url";
  return "unknown";
}

function placeholderSong(id: string): SongSummary {
  return {
    id,
    title: `未知歌曲 (${id})`,
    artists: [],
    album: { id: null, name: null, coverUrl: null },
    durationMs: null,
    fee: null,
    copyright: null,
    neteaseUrl: `https://music.163.com/song?id=${encodeURIComponent(id)}`,
  };
}

export class NeteaseClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly detailBatchSize: number;
  private readonly playbackBatchSize: number;
  private readonly cloudPageSize: number;
  private readonly maxCloudSongs: number;
  private readonly qrTtlMs: number;
  private readonly now: () => number;

  constructor(options: NeteaseClientOptions = {}) {
    // Cloudflare's global fetch must keep its runtime receiver. Calling a
    // detached native fetch as `this.fetcher(...)` throws `Illegal invocation`.
    const customFetch = options.fetch;
    this.fetcher = customFetch
      ? (input, init) => customFetch(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    if (!ALLOWED_BASE_URLS.has(this.baseUrl)) {
      throw new NeteaseError("unsupported_protocol", "NetEase requests are restricted to an allowlisted HTTPS origin");
    }
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 12_000);
    this.retryCount = Math.min(2, Math.max(0, options.retryCount ?? 1));
    this.detailBatchSize = Math.min(500, Math.max(1, options.detailBatchSize ?? 400));
    // 200 keeps a ~2k-song snapshot below the free Worker subrequest ceiling,
    // even when one retry is needed, while remaining conservative upstream.
    this.playbackBatchSize = Math.min(200, Math.max(1, options.playbackBatchSize ?? 200));
    this.cloudPageSize = Math.min(500, Math.max(1, options.cloudPageSize ?? 200));
    this.maxCloudSongs = Math.max(this.cloudPageSize, options.maxCloudSongs ?? 10_000);
    this.qrTtlMs = Math.max(60_000, options.qrTtlMs ?? 10 * 60_000);
    this.now = options.now ?? Date.now;
  }

  private async request(path: string, data: Record<string, string | number>, session?: NeteaseSession): Promise<RequestResult> {
    if (!/^\/api\/[A-Za-z0-9_./-]+$/.test(path)) {
      throw new NeteaseError("unsupported_protocol", "Refused a non-allowlisted NetEase API path", { endpoint: path });
    }
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) body.set(key, String(value));

    let lastError: NeteaseError | null = null;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = new Headers({
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Referer: "https://music.163.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 NeteaseMusicLossGuard/1.0",
        });
        if (session) headers.set("Cookie", sessionCookieHeader(session));

        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: "POST",
          headers,
          body: body.toString(),
          signal: controller.signal,
          cache: "no-store",
          redirect: "follow",
        });
        const setCookies = readSetCookieHeaders(response.headers);
        if (session && setCookies.length > 0) mergeSessionSetCookies(session, setCookies, this.now());

        if (!response.ok) {
          const kind = response.status === 429 ? "rate_limited" : "http";
          throw new NeteaseError(kind, "NetEase returned an HTTP error", {
            endpoint: path,
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
          });
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch (cause) {
          throw new NeteaseError("invalid_response", "NetEase returned malformed JSON", {
            endpoint: path,
            cause,
          });
        }
        if (!isRecord(parsed)) {
          throw new NeteaseError("invalid_response", "NetEase returned an unexpected JSON shape", { endpoint: path });
        }
        return { body: parsed, setCookies };
      } catch (cause) {
        if (cause instanceof NeteaseError) {
          lastError = cause;
        } else if (controller.signal.aborted) {
          lastError = new NeteaseError("timeout", "NetEase request timed out", {
            endpoint: path,
            retryable: true,
            cause,
          });
        } else {
          lastError = new NeteaseError("network", "NetEase request failed at the network layer", {
            endpoint: path,
            retryable: true,
            cause,
          });
        }
      } finally {
        clearTimeout(timeout);
      }

      if (!lastError.retryable || attempt >= this.retryCount) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    }
    throw lastError ?? new NeteaseError("network", "NetEase request failed", { endpoint: path });
  }

  async createQrLogin(): Promise<QrLoginChallenge> {
    const { body } = await this.request("/api/login/qrcode/unikey", { type: 3, timestamp: this.now() });
    assertApiSuccess(body, "/api/login/qrcode/unikey");
    const key = toStringOrNull(body.unikey) ?? (isRecord(body.data) ? toStringOrNull(body.data.unikey) : null);
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw new NeteaseError("invalid_response", "NetEase did not return a valid QR login key", {
        endpoint: "/api/login/qrcode/unikey",
      });
    }
    return {
      key,
      qrUrl: `https://music.163.com/login?codekey=${encodeURIComponent(key)}`,
      expiresAt: new Date(this.now() + this.qrTtlMs).toISOString(),
    };
  }

  async checkQrLogin(key: string): Promise<QrLoginCheckResult> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new TypeError("Invalid QR login key");
    const { body, setCookies } = await this.request("/api/login/qrcode/client/login", {
      key,
      type: 3,
      timestamp: this.now(),
    });
    const code = apiCode(body);
    if (code === 800) return { state: "expired", profile: null };
    if (code === 801) return { state: "waiting_scan", profile: null };
    if (code === 802) {
      return {
        state: "waiting_confirm",
        profile: {
          userId: "",
          nickname: toStringOrNull(body.nickname) ?? "",
          avatarUrl: toStringOrNull(body.avatarUrl),
        },
      };
    }
    if (code !== 803) {
      assertApiSuccess(body, "/api/login/qrcode/client/login");
      throw new NeteaseError("invalid_response", "NetEase returned an unknown QR state", {
        endpoint: "/api/login/qrcode/client/login",
        apiCode: code ?? undefined,
      });
    }

    const bodyCookie = toStringOrNull(body.cookie);
    const cookieSource = bodyCookie || cookieHeaderFromSetCookie(setCookies);
    if (!cookieSource) {
      throw new NeteaseError("authentication", "QR authorization succeeded without an authenticated cookie", {
        endpoint: "/api/login/qrcode/client/login",
      });
    }
    const session = createNeteaseSession(cookieSource, this.now());
    if (setCookies.length > 0) mergeSessionSetCookies(session, setCookies, this.now());
    if (!sessionHasAuthentication(session)) {
      throw new NeteaseError("authentication", "QR authorization did not yield MUSIC_U or MUSIC_A", {
        endpoint: "/api/login/qrcode/client/login",
      });
    }
    const login = await this.getLoginStatus(session);
    if (login.state !== "valid" || !login.profile) {
      throw loginStateError(login.state);
    }
    return { state: "authorized", profile: login.profile, session };
  }

  async getLoginStatus(session: NeteaseSession): Promise<LoginStatus> {
    const { body } = await this.request("/api/nuser/account/get", { timestamp: this.now() }, session);
    const code = apiCode(body);
    if (code === 301 || code === 302) return { state: "expired", profile: null, accountId: null };
    if (code === 250 || code === 509 || code === 512) {
      return { state: "risk_controlled", profile: null, accountId: null };
    }
    assertApiSuccess(body, "/api/nuser/account/get");
    const profileValue = isRecord(body.profile) ? body.profile : null;
    const accountValue = isRecord(body.account) ? body.account : null;
    if (!profileValue) return { state: "anonymous", profile: null, accountId: null };
    const userId = toSongId(profileValue.userId);
    if (!userId) {
      throw new NeteaseError("invalid_response", "NetEase login profile is missing a valid user id", {
        endpoint: "/api/nuser/account/get",
      });
    }
    return {
      state: "valid",
      profile: {
        userId,
        nickname: toStringOrNull(profileValue.nickname) ?? "",
        avatarUrl: toStringOrNull(profileValue.avatarUrl),
      },
      accountId: toSongId(accountValue?.id) ?? userId,
    };
  }

  async refreshSession(session: NeteaseSession): Promise<RefreshResult> {
    try {
      const { body, setCookies } = await this.request("/api/login/token/refresh", { timestamp: this.now() }, session);
      const code = apiCode(body);
      if (code === 301 || code === 302) {
        return { status: "reauth_required", login: { state: "expired", profile: null, accountId: null } };
      }
      assertApiSuccess(body, "/api/login/token/refresh");
      const login = await this.getLoginStatus(session);
      return {
        status: login.state === "valid" ? (setCookies.length > 0 ? "refreshed" : "unchanged") : "reauth_required",
        login,
      };
    } catch (error) {
      if (error instanceof NeteaseError && (error.kind === "authentication" || error.kind === "risk_control")) {
        const login = await this.getLoginStatus(session).catch((): LoginStatus => ({
          state: error.kind === "risk_control" ? "risk_controlled" : "expired",
          profile: null,
          accountId: null,
        }));
        return { status: "reauth_required", login };
      }
      throw error;
    }
  }

  async getPlaylistDetail(playlistId: string | number, session?: NeteaseSession): Promise<PlaylistDetail> {
    const id = requireSongId(playlistId, "playlist id");
    const endpoint = "/api/v6/playlist/detail";
    const { body } = await this.request(endpoint, { id, n: 100_000, s: 8, timestamp: this.now() }, session);
    assertApiSuccess(body, endpoint);
    if (!isRecord(body.playlist)) {
      throw new NeteaseError("invalid_response", "NetEase playlist detail is missing the playlist object", { endpoint });
    }
    const raw = body.playlist;
    const trackIds = Array.isArray(raw.trackIds)
      ? raw.trackIds.flatMap((entry): string[] => {
          const idValue = isRecord(entry) ? toSongId(entry.id) : toSongId(entry);
          return idValue ? [idValue] : [];
        })
      : [];
    const embeddedTracks = Array.isArray(raw.tracks)
      ? raw.tracks.flatMap((song): SongSummary[] => {
          const normalized = normalizeSong(song);
          return normalized ? [normalized] : [];
        })
      : [];
    const userId = toSongId(raw.userId);
    const normalizedId = toSongId(raw.id);
    const trackCount = toInteger(raw.trackCount);
    if (!userId || !normalizedId || trackCount === null || trackCount < 0) {
      throw new NeteaseError("invalid_response", "NetEase playlist identity or count is invalid", { endpoint });
    }
    return {
      id: normalizedId,
      name: toStringOrNull(raw.name) ?? "未命名歌单",
      userId,
      ownerName: isRecord(raw.creator)
        ? toStringOrNull(raw.creator.nickname) ?? "未知所有者"
        : "未知所有者",
      coverUrl: toStringOrNull(raw.coverImgUrl) ?? toStringOrNull(raw.picUrl),
      privacy: toInteger(raw.privacy),
      trackCount,
      cloudTrackCount: Math.max(0, toInteger(raw.cloudTrackCount) ?? 0),
      trackIds: [...new Set(trackIds)],
      embeddedTracks,
      updateTime: toIso(raw.updateTime),
    };
  }

  async getUserPlaylists(
    userId: string | number,
    session: NeteaseSession,
    offset = 0,
    limit = 50,
  ): Promise<PlaylistPage> {
    const uid = requireSongId(userId, "user id");
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const endpoint = "/api/user/playlist";
    const { body } = await this.request(endpoint, {
      uid,
      offset: safeOffset,
      limit: safeLimit,
      includeVideo: 1,
      timestamp: this.now(),
    }, session);
    assertApiSuccess(body, endpoint);
    if (!Array.isArray(body.playlist)) {
      throw new NeteaseError("invalid_response", "NetEase playlist response is missing playlists", { endpoint });
    }
    const playlists = body.playlist.flatMap((value): PlaylistDetail[] => {
      if (!isRecord(value)) return [];
      const id = toSongId(value.id);
      const ownerUid = toSongId(value.userId ?? (isRecord(value.creator) ? value.creator.userId : null));
      const trackCount = toInteger(value.trackCount);
      if (!id || !ownerUid || trackCount === null || trackCount < 0) return [];
      return [{
        id,
        name: toStringOrNull(value.name) ?? "未命名歌单",
        userId: ownerUid,
        ownerName: isRecord(value.creator)
          ? toStringOrNull(value.creator.nickname) ?? "未知所有者"
          : "未知所有者",
        coverUrl: toStringOrNull(value.coverImgUrl) ?? toStringOrNull(value.picUrl),
        privacy: toInteger(value.privacy),
        trackCount,
        cloudTrackCount: Math.max(0, toInteger(value.cloudTrackCount) ?? 0),
        trackIds: [],
        embeddedTracks: [],
        updateTime: toIso(value.updateTime),
      }];
    });
    if (playlists.length !== body.playlist.length) {
      throw new NeteaseError("invalid_response", "NetEase playlist response contains invalid metadata", { endpoint });
    }
    const total = Math.max(playlists.length + safeOffset, toInteger(body.count) ?? playlists.length + safeOffset);
    const upstreamClaimsMore = body.more === true || safeOffset + playlists.length < total;
    return {
      playlists,
      total,
      // Some NetEase accounts return a stale `more: true` even when a page
      // contains fewer rows than requested. Treat a short page as terminal so
      // callers do not repeatedly fetch and append the first page forever.
      hasMore: playlists.length >= safeLimit && upstreamClaimsMore,
      offset: safeOffset,
      limit: safeLimit,
    };
  }

  async getCloudSongPage(session: NeteaseSession, offset = 0, limit = this.cloudPageSize): Promise<CloudSongPage> {
    const endpoint = "/api/v1/cloud/get";
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
    const { body } = await this.request(endpoint, { limit: safeLimit, offset: safeOffset, timestamp: this.now() }, session);
    assertApiSuccess(body, endpoint);
    if (!Array.isArray(body.data)) {
      throw new NeteaseError("invalid_response", "NetEase cloud response is missing data", { endpoint });
    }
    const songs = body.data.flatMap((value): CloudSong[] => {
      const song = normalizeCloudSong(value);
      return song ? [song] : [];
    });
    if (songs.length !== body.data.length) {
      throw new NeteaseError("invalid_response", "NetEase cloud response contains an invalid song", { endpoint });
    }
    return {
      songs,
      total: Math.max(0, toInteger(body.count ?? body.size) ?? songs.length),
      hasMore: body.hasMore === true,
      offset: safeOffset,
      limit: safeLimit,
    };
  }

  async getAllCloudSongs(session: NeteaseSession): Promise<CloudSong[]> {
    const songs = new Map<string, CloudSong>();
    let offset = 0;
    let expectedTotal: number | null = null;
    for (;;) {
      const page = await this.getCloudSongPage(session, offset, this.cloudPageSize);
      expectedTotal ??= page.total;
      for (const song of page.songs) songs.set(song.id, song);
      if (songs.size > this.maxCloudSongs) {
        throw new NeteaseError("incomplete_response", "NetEase cloud pagination exceeded the configured safety cap", {
          endpoint: "/api/v1/cloud/get",
        });
      }
      if (!page.hasMore) break;
      if (page.songs.length === 0) {
        throw new NeteaseError("incomplete_response", "NetEase cloud pagination stalled on an empty page", {
          endpoint: "/api/v1/cloud/get",
        });
      }
      offset += page.songs.length;
    }
    if (expectedTotal !== null && songs.size !== expectedTotal) {
      throw new NeteaseError("incomplete_response", "NetEase cloud pagination did not match its declared total", {
        endpoint: "/api/v1/cloud/get",
      });
    }
    return [...songs.values()];
  }

  async getCloudSongDetails(ids: readonly (string | number)[], session: NeteaseSession): Promise<CloudSong[]> {
    const normalizedIds = uniqueSongIds(ids);
    if (normalizedIds.length === 0) return [];
    const endpoint = "/api/v1/cloud/get/byids";
    const output: CloudSong[] = [];
    for (const batch of chunks(normalizedIds, 200)) {
      const { body } = await this.request(endpoint, { songIds: batch.join(","), timestamp: this.now() }, session);
      assertApiSuccess(body, endpoint);
      if (!Array.isArray(body.data)) {
        throw new NeteaseError("invalid_response", "NetEase cloud detail response is missing data", { endpoint });
      }
      output.push(...body.data.flatMap((value): CloudSong[] => {
        const song = normalizeCloudSong(value);
        return song ? [song] : [];
      }));
    }
    return output;
  }

  async getSongDetails(ids: readonly (string | number)[], session?: NeteaseSession): Promise<SongDetailBatch> {
    const normalizedIds = uniqueSongIds(ids);
    if (normalizedIds.length === 0) return { songs: [], missingIds: [] };
    const endpoint = "/api/v3/song/detail";
    const songs = new Map<string, SongSummary>();
    for (const batch of chunks(normalizedIds, this.detailBatchSize)) {
      const requestShape = JSON.stringify(batch.map((id) => ({ id: Number(id) })));
      const { body } = await this.request(endpoint, { c: requestShape, timestamp: this.now() }, session);
      assertApiSuccess(body, endpoint);
      if (!Array.isArray(body.songs)) {
        throw new NeteaseError("invalid_response", "NetEase song-detail response is missing songs", { endpoint });
      }
      for (const value of body.songs) {
        const song = normalizeSong(value);
        if (song) songs.set(song.id, song);
      }
    }
    return {
      songs: [...songs.values()],
      missingIds: normalizedIds.filter((id) => !songs.has(id)),
    };
  }

  async getPlaybackAvailability(
    ids: readonly (string | number)[],
    session: NeteaseSession,
  ): Promise<PlaybackAvailability[]> {
    const normalizedIds = uniqueSongIds(ids);
    if (normalizedIds.length === 0) return [];
    const endpoint = "/api/song/enhance/player/url";
    const output = new Map<string, PlaybackAvailability>();
    for (const batch of chunks(normalizedIds, this.playbackBatchSize)) {
      const { body } = await this.request(endpoint, {
        ids: JSON.stringify(batch.map(Number)),
        br: 128_000,
        timestamp: this.now(),
      }, session);
      assertApiSuccess(body, endpoint);
      if (!Array.isArray(body.data)) {
        throw new NeteaseError("invalid_response", "NetEase playback response is missing data", { endpoint });
      }
      for (const value of body.data) {
        if (!isRecord(value)) continue;
        const id = toSongId(value.id);
        if (!id || !batch.includes(id)) continue;
        const code = toInteger(value.code);
        const playable = code === 200 && typeof value.url === "string" && value.url.length > 0;
        output.set(id, {
          id,
          playable,
          code,
          reason: playbackReason(value, playable),
          freeTrial: value.freeTrialInfo !== null && value.freeTrialInfo !== undefined,
        });
      }
      const missing = batch.filter((id) => !output.has(id));
      if (missing.length > 0) {
        throw new NeteaseError("incomplete_response", "NetEase playback response omitted requested songs", {
          endpoint,
        });
      }
    }
    return normalizedIds.map((id) => output.get(id) as PlaybackAvailability);
  }

  async getAccountSnapshot(session: NeteaseSession, options: AccountSnapshotOptions): Promise<AccountSnapshot> {
    const strict = options.strictCompleteness ?? true;
    const login = await this.getLoginStatus(session);
    if (login.state !== "valid" || !login.profile) {
      throw loginStateError(login.state);
    }
    if (options.expectedUserId && login.profile.userId !== requireSongId(options.expectedUserId, "expected user id")) {
      throw new NeteaseError("uid_mismatch", "The authenticated NetEase account is not the configured owner");
    }

    // Kept sequential to avoid triggering account risk control and Worker subrequest bursts.
    const playlist = await this.getPlaylistDetail(options.playlistId, session);
    const trackIds = uniqueSongIds(playlist.trackIds);
    const warnings: string[] = [];

    if (playlist.trackIds.length < playlist.trackCount) {
      const message = `Playlist returned ${playlist.trackIds.length} unique track ids for declared trackCount ${playlist.trackCount}.`;
      if (strict) {
        throw new NeteaseError("incomplete_response", message, { endpoint: "/api/v6/playlist/detail" });
      }
      warnings.push(message);
    } else if (playlist.trackIds.length > playlist.trackCount) {
      // NetEase's summary count can lag behind or exclude account-specific
      // entries. The complete trackIds list is the canonical membership source.
      warnings.push(
        `Playlist returned ${playlist.trackIds.length} unique track ids; summary trackCount was ${playlist.trackCount}.`,
      );
    }

    const detailBatch = await this.getSongDetails(trackIds, session);
    const cloudSongs = await this.getCloudSongDetails(detailBatch.missingIds, session);
    const availability = await this.getPlaybackAvailability(trackIds, session);
    const detailById = new Map(detailBatch.songs.map((song) => [song.id, song]));
    const embeddedById = new Map(playlist.embeddedTracks.map((song) => [song.id, song]));
    const cloudById = new Map<string, CloudSong>();
    for (const song of cloudSongs) {
      cloudById.set(song.id, song);
      if (song.simpleSong) cloudById.set(song.simpleSong.id, song);
    }
    const availabilityById = new Map(availability.map((item) => [item.id, item]));
    const unresolvedDetailIds = detailBatch.missingIds.filter(
      (id) => !cloudById.has(id) && !embeddedById.has(id),
    );
    if (strict && unresolvedDetailIds.length > 0) {
      throw new NeteaseError(
        "incomplete_response",
        `NetEase song-detail batches omitted ${unresolvedDetailIds.length} requested ids without a cloud or playlist fallback`,
        { endpoint: "/api/v3/song/detail" },
      );
    }
    if (detailBatch.missingIds.length > 0) {
      warnings.push(
        `${detailBatch.missingIds.length} playlist tracks had no standard song-detail record; cloud/playlist fallbacks were used where available.`,
      );
    }
    return {
      capturedAt: new Date(this.now()).toISOString(),
      userId: login.profile.userId,
      playlist,
      trackIds,
      cloudSongs,
      songs: trackIds.map((id) => {
        const cloud = cloudById.get(id);
        const playback = availabilityById.get(id);
        if (!playback) {
          throw new NeteaseError("incomplete_response", "Playback result disappeared during snapshot assembly");
        }
        return {
          id,
          song: detailById.get(id) ?? (cloud ? cloudSongAsSummary(cloud) : null) ?? embeddedById.get(id) ?? placeholderSong(id),
          playable: playback.playable,
          playbackCode: playback.code,
          playbackReason: playback.reason,
          inCloud: Boolean(cloud),
        };
      }),
      warnings,
    };
  }
}
