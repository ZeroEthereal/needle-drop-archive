"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  CursorPage,
  LoadState,
  MotionMode,
  PlaylistChoice,
  QrLogin,
  QrLoginState,
  RecoveryItem,
  RecoveryKind,
  SessionStatus,
  SongRecord,
  SongState,
  SyncState,
  SyncStatus,
  ViewId,
} from "../ui-types";

type UnknownRecord = Record<string, unknown>;
type RequestOption = { url: string; init?: RequestInit };
type RecoveryFilter = "all" | RecoveryKind;
type LibraryViewMode = "list" | "grid";
type Toast = { message: string; tone: "good" | "bad" | "info" };

const LIKES_PAGE_SIZE = 100;

const navItems: Array<{
  id: ViewId;
  label: string;
  eyebrow: string;
  glyph: string;
}> = [
  { id: "recovery", label: "待找回", eyebrow: "RECOVER", glyph: "⌁" },
  { id: "likes", label: "歌单歌曲", eyebrow: "LIBRARY", glyph: "♡" },
  { id: "sync", label: "同步状态", eyebrow: "PULSE", glyph: "↻" },
];

const motionOptions: Array<{ id: MotionMode; label: string }> = [
  { id: "immersive", label: "沉浸" },
  { id: "balanced", label: "均衡" },
  { id: "static", label: "静态" },
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.data !== undefined) return value.data;
  if (value.result !== undefined && isRecord(value.result)) return value.result;
  return value;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeArtists(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((artist) => {
        if (typeof artist === "string") return artist.trim();
        if (isRecord(artist)) return firstString(artist.name, artist.artistName);
        return undefined;
      })
      .filter((artist): artist is string => Boolean(artist));
  }
  if (typeof value === "string") {
    return value
      .split(/[、,/]/)
      .map((artist) => artist.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSong(value: unknown, forcedState?: SongState): SongRecord | null {
  if (!isRecord(value)) return null;
  const id = firstString(value.id, value.songId, value.trackId);
  if (!id) return null;

  const albumValue = value.album ?? value.al;
  const albumRecord = isRecord(albumValue) ? albumValue : undefined;
  const rawState = firstString(value.state, value.status)?.toLowerCase();
  let state: SongState = forcedState ?? "unknown";
  if (!forcedState) {
    if (value.grey === true || rawState === "grey" || rawState === "gray") state = "grey";
    else if (rawState === "missing" || rawState === "disappeared") state = "missing";
    else if (value.playable === true || rawState === "playable" || rawState === "normal") {
      state = "playable";
    }
  }

  const rawSource = firstString(value.source, value.origin)?.toLowerCase();
  const source =
    value.cloud === true || rawSource === "cloud"
      ? "cloud"
      : rawSource === "catalog" || rawSource === "official"
        ? "catalog"
        : "unknown";

  return {
    id,
    title: firstString(value.title, value.name, value.songName) ?? "未命名歌曲",
    artists: normalizeArtists(value.artists ?? value.artist ?? value.ar),
    album:
      firstString(
        typeof albumValue === "string" ? albumValue : undefined,
        albumRecord?.name,
        value.albumName,
      ) ?? "未知专辑",
    coverUrl: firstString(
      value.coverUrl,
      value.cover,
      value.picUrl,
      albumRecord?.picUrl,
    ),
    neteaseUrl:
      firstString(value.neteaseUrl, value.url, value.songUrl) ??
      `https://music.163.com/#/song?id=${encodeURIComponent(id)}`,
    firstSeenAt: firstString(value.firstSeenAt, value.createdAt),
    lastSeenAt: firstString(value.lastSeenAt, value.updatedAt),
    state,
    source,
  };
}

function normalizeRecovery(value: unknown): RecoveryItem | null {
  if (!isRecord(value)) return null;
  const rawKind = firstString(value.type, value.kind, value.status)?.toLowerCase();
  const kind: RecoveryKind =
    rawKind === "grey" || rawKind === "gray" || rawKind === "unavailable"
      ? "grey"
      : "missing";
  const song = normalizeSong(value.song ?? value.track ?? value, kind);
  if (!song) return null;
  return {
    kind,
    song,
    lastNormalAt: firstString(value.lastNormalAt, value.lastSeenAt, song.lastSeenAt),
    confirmedAt: firstString(value.confirmedAt, value.detectedAt, value.createdAt),
  };
}

function normalizePage<T>(value: unknown, mapper: (item: unknown) => T | null): CursorPage<T> {
  const body = unwrap(value);
  const record = isRecord(body) ? body : undefined;
  const rawItems = Array.isArray(body)
    ? body
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.tracks)
        ? record.tracks
        : Array.isArray(record?.songs)
          ? record.songs
          : [];
  return {
    items: rawItems.map(mapper).filter((item): item is T => item !== null),
    nextCursor: firstString(record?.nextCursor, record?.cursor),
    total: firstNumber(record?.total, record?.count, record?.trackCount),
  };
}

function normalizeSessionStatus(value: unknown): SessionStatus {
  const status = firstString(value)?.toLowerCase();
  if (status === "valid" || status === "authenticated" || status === "ready") return "valid";
  if (status === "anonymous" || status === "missing" || status === "logged_out") {
    return "anonymous";
  }
  if (status === "expired" || status === "reauth_required") return "expired";
  if (status === "risk_controlled" || status === "risk" || status === "blocked") {
    return "risk_controlled";
  }
  return "unknown";
}

function normalizeSyncState(value: unknown): SyncState {
  const state = firstString(value)?.toLowerCase();
  if (state === "idle") return "idle";
  if (state === "queued" || state === "pending") return "queued";
  if (state === "running" || state === "syncing") return "running";
  if (state === "success" || state === "succeeded" || state === "completed") return "success";
  if (state === "failed" || state === "error") return "failed";
  if (state === "reauth_required") return "reauth_required";
  if (state === "unconfigured" || state === "not_configured") return "unconfigured";
  return "unknown";
}

function normalizeStatus(value: unknown): SyncStatus {
  const body = unwrap(value);
  const record = isRecord(body) ? body : {};
  const sessionRecord = isRecord(record.session) ? record.session : undefined;
  const profileRecord = isRecord(record.profile)
    ? record.profile
    : isRecord(sessionRecord?.profile)
      ? sessionRecord.profile
      : undefined;
  const playlistRecord = isRecord(record.playlist) ? record.playlist : undefined;
  const bindingRecord = isRecord(record.binding) ? record.binding : undefined;
  const bindingError = isRecord(bindingRecord?.error) ? bindingRecord.error : undefined;
  let progress = firstNumber(record.progress, record.percent);
  if (progress !== undefined && progress > 1) progress /= 100;

  return {
    state: normalizeSyncState(record.state ?? record.status),
    phase: firstString(record.phase, record.step, record.currentStep),
    lastSuccessAt: firstString(record.lastSuccessAt, record.lastSyncedAt),
    nextRunAt: firstString(record.nextRunAt, record.nextSyncAt),
    totalSongCount: firstNumber(record.totalSongCount, record.currentSongCount, record.trackCount),
    normalCount: firstNumber(record.normalCount),
    missingCount: firstNumber(record.missingCount, record.disappearedCount),
    greyCount: firstNumber(record.greyCount, record.grayCount),
    sessionStatus: normalizeSessionStatus(
      record.sessionStatus ?? sessionRecord?.state ?? sessionRecord?.status,
    ),
    error: firstString(record.error, record.lastError, record.message),
    progress,
    profile: profileRecord
      ? {
          userId: firstString(profileRecord.userId, profileRecord.id),
          nickname: firstString(profileRecord.nickname, profileRecord.name),
          avatarUrl: firstString(profileRecord.avatarUrl, profileRecord.avatar),
        }
      : undefined,
    setupState: firstString(record.setupState) as SyncStatus["setupState"],
    bindingVersion: firstNumber(record.bindingVersion),
    playlist: playlistRecord && firstString(playlistRecord.id)
      ? {
          id: firstString(playlistRecord.id) as string,
          name: firstString(playlistRecord.name) ?? "已绑定歌单",
          coverUrl: firstString(playlistRecord.coverUrl),
          ownerUid: firstString(playlistRecord.ownerUid),
          ownerName: firstString(playlistRecord.ownerName),
          owned: playlistRecord.owned === true,
          boundAt: firstString(playlistRecord.boundAt),
        }
      : undefined,
    binding: bindingRecord && firstString(bindingRecord.id)
      ? {
          id: firstString(bindingRecord.id) as string,
          state: (firstString(bindingRecord.state) ?? "preparing") as "preparing" | "running" | "failed",
          error: bindingError ? {
            code: firstString(bindingError.code) ?? "BINDING_FAILED",
            message: firstString(bindingError.message) ?? "新歌单读取失败，原数据没有变化。",
          } : undefined,
        }
      : undefined,
  };
}

async function requestJson(options: RequestOption[]): Promise<unknown> {
  let lastError: unknown = new Error("接口暂不可用");
  for (const option of options) {
    try {
      const response = await fetch(option.url, {
        ...option.init,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(option.init?.body ? { "Content-Type": "application/json" } : {}),
          ...(option.init?.method && option.init.method.toUpperCase() !== "GET"
            ? { "X-Requested-With": "ncm-archive" }
            : {}),
          ...option.init?.headers,
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = text;
        let code: string | undefined;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (isRecord(parsed)) {
            const error = isRecord(parsed.error) ? parsed.error : undefined;
            message = firstString(error?.message, parsed.message) ?? text;
            code = firstString(error?.code, parsed.code);
          }
        } catch {
          // Non-JSON errors are still useful (for example, a Cloudflare Access response).
        }
        lastError = new RequestJsonError(
          message || `请求失败（${response.status}）`,
          response.status,
          code,
        );
        continue;
      }
      if (response.status === 204) return {};
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

class RequestJsonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RequestJsonError";
  }
}

function useDebounced<T>(value: T, delay = 280): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function formatDateTime(value?: string): string {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatNumber(value?: number): string {
  return value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function artistLine(song: SongRecord): string {
  return song.artists.length ? song.artists.join(" / ") : "未知歌手";
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy_failed");
}

function includesSong(song: SongRecord, query: string): boolean {
  if (!query.trim()) return true;
  const keyword = query.trim().toLowerCase();
  return [song.title, artistLine(song), song.album].some((part) =>
    part.toLowerCase().includes(keyword),
  );
}

function sessionLabel(status: SessionStatus): string {
  if (status === "valid") return "登录态正常";
  if (status === "anonymous") return "尚未登录";
  if (status === "expired") return "需要重新授权";
  if (status === "risk_controlled") return "网易云风控中";
  return "等待检测";
}

function syncLabel(status?: SyncStatus): string {
  if (!status) return "等待服务接入";
  if (status.state === "running") return "正在同步";
  if (status.state === "queued") return "同步已排队";
  if (status.state === "failed") return "上次同步失败";
  if (status.sessionStatus !== "valid") return sessionLabel(status.sessionStatus);
  if (status.lastSuccessAt) return "守护正常运行";
  return "等待首次同步";
}

function phaseIndex(phase?: string): number {
  const value = phase?.toLowerCase() ?? "";
  if (/session|login|auth|会话|登录/.test(value)) return 0;
  if (/playlist|fetch|歌单|拉取/.test(value)) return 1;
  if (/detail|privilege|inspect|歌曲|检查/.test(value)) return 2;
  if (/compare|diff|比对/.test(value)) return 3;
  if (/persist|write|database|入库|保存/.test(value)) return 4;
  return -1;
}

function qrState(value: unknown): QrLoginState {
  const state = firstString(value)?.toLowerCase();
  if (state === "800" || state === "expired") return "expired";
  if (state === "801" || state === "waiting_scan" || state === "pending") {
    return "waiting_scan";
  }
  if (state === "802" || state === "waiting_confirm" || state === "scanned") {
    return "waiting_confirm";
  }
  if (state === "803" || state === "authorized" || state === "success") {
    return "authorized";
  }
  return "error";
}

function SongCover({ song, size = "regular" }: { song: SongRecord; size?: "regular" | "large" }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`song-cover song-cover-${size}`} aria-hidden="true">
      {song.coverUrl && !failed ? (
        // Remote artwork domains vary for cloud tracks, so a native image is safer than a fixed host allowlist.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={song.coverUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span>{song.title.slice(0, 1).toUpperCase()}</span>
      )}
      <i />
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <span aria-hidden="true">⌕</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label="清空搜索">
          ×
        </button>
      ) : null}
    </label>
  );
}

function FilterPills<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="filter-pills" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
        >
          {option.label}
          {option.count !== undefined ? <small>{option.count}</small> : null}
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  unavailable,
  title,
  body,
  action,
}: {
  unavailable?: boolean;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className={`empty-orbit ${unavailable ? "is-paused" : ""}`} aria-hidden="true">
        <span />
        <i />
      </div>
      <p className="micro-label">{unavailable ? "WAITING FOR SIGNAL" : "ALL QUIET"}</p>
      <h3>{title}</h3>
      <p>{body}</p>
      {action ? <div className="empty-actions">{action}</div> : null}
    </section>
  );
}

function LoadingRows({ count = 5 }: { count?: number }) {
  return (
    <div className="loading-rows" aria-label="正在读取数据" aria-busy="true">
      {Array.from({ length: count }).map((_, index) => (
        <div className="loading-row" key={index}>
          <i />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  description: string;
  right?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p className="micro-label">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {right ? <div className="heading-right">{right}</div> : null}
    </header>
  );
}

function StatusBadge({ kind }: { kind: RecoveryKind }) {
  return (
    <span className={`status-badge status-${kind}`}>
      <i />
      {kind === "missing" ? "已消失" : "已变灰"}
    </span>
  );
}

function AmbientStage({ motion }: { motion: MotionMode }) {
  const particles = useMemo(
    () =>
      Array.from({ length: 30 }).map((_, index) => {
        const style = {
          "--x": `${(index * 37 + 11) % 101}%`,
          "--y": `${(index * 61 + 17) % 97}%`,
          "--size": `${1 + ((index * 7) % 4)}px`,
          "--delay": `${-((index * 1.7) % 13)}s`,
          "--travel": `${18 + ((index * 13) % 44)}px`,
        } as CSSProperties;
        return <i key={index} style={style} />;
      }),
    [],
  );

  return (
    <div className={`ambient-stage ambient-${motion}`} aria-hidden="true">
      <div className="aurora aurora-one" />
      <div className="aurora aurora-two" />
      <div className="aurora aurora-three" />
      <div className="stage-grid" />
      <div className="particle-field">{particles}</div>
      <div className="noise-layer" />
    </div>
  );
}

function VinylHero({ pending, unavailable }: { pending?: number; unavailable: boolean }) {
  const title = unavailable
    ? "把每一次喜欢，都留在时间里"
    : pending
      ? `${pending} 首旋律，等待重回你的耳机`
      : "你的歌单，正被好好守护";
  return (
    <section className="vinyl-hero">
      <div className="hero-copy">
        <p className="micro-label">YOUR MUSIC REMEMBERS</p>
        <h2>{title}</h2>
        <p>
          每日留下一张完整快照。歌曲消失或变灰时，它不会再无声无息地从记忆里离开。
        </p>
        <div className="hero-signal">
          <span className="live-dot" />
          {unavailable ? "等待首次连接" : pending ? "有新的回声需要处理" : "当前没有异常"}
        </div>
      </div>
      <div className="vinyl-scene" aria-hidden="true">
        <div className="vinyl-halo" />
        <div className="vinyl-record">
          <div className="vinyl-shine" />
          <div className="vinyl-label">
            <span>回声</span>
            <small>ECHO 01</small>
          </div>
          <div className="vinyl-hole" />
        </div>
        <div className="tonearm">
          <i />
          <span />
        </div>
        <div className="hero-equalizer">
          {Array.from({ length: 22 }).map((_, index) => (
            <i key={index} style={{ "--bar": (index * 17) % 9 } as CSSProperties} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RecoveryView({
  status,
  loadState,
  items,
  filter,
  setFilter,
  query,
  setQuery,
  onComplete,
  onCopy,
  completingSongId,
  nextCursor,
  loadingMore,
  onLoadMore,
  onGoSync,
}: {
  status?: SyncStatus;
  loadState: LoadState;
  items: RecoveryItem[];
  filter: RecoveryFilter;
  setFilter: (value: RecoveryFilter) => void;
  query: string;
  setQuery: (value: string) => void;
  onComplete: (item: RecoveryItem) => void;
  onCopy: (item: RecoveryItem, mode: "title" | "title-artist") => void;
  completingSongId?: string;
  nextCursor?: string;
  loadingMore: boolean;
  onLoadMore: () => void;
  onGoSync: () => void;
}) {
  const counts = useMemo(
    () => ({
      missing: status?.missingCount ?? items.filter((item) => item.kind === "missing").length,
      grey: status?.greyCount ?? items.filter((item) => item.kind === "grey").length,
    }),
    [items, status?.greyCount, status?.missingCount],
  );
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === "all" || item.kind === filter) && includesSong(item.song, query),
      ),
    [filter, items, query],
  );
  const pending = status ? counts.missing + counts.grey : items.length;

  return (
    <div className="view-stack view-recovery">
      <VinylHero pending={pending} unavailable={loadState === "unavailable"} />
      <PageHeading
        eyebrow="RECOVERY QUEUE"
        title="待找回"
        description="这里只收纳已经确认的异常：仍在歌单但不可播放的是变灰，彻底离开歌单的是消失。"
        right={<span className="heading-count">{loadState === "ready" ? visible.length : "—"} 首</span>}
      />
      <div className="recovery-explainer">
        <span className="explainer-icon">!</span>
        <p>
          <span className="recovery-explainer-line"><strong>注意：</strong>找回变灰歌曲后，请先将歌曲上传至网易云云盘，然后取消收藏原灰色歌曲之后重新收藏云盘中的歌曲，再回到这里点击“完成”。</span>
        </p>
      </div>
      <div className="toolbar glass-panel">
        <FilterPills
          label="待找回状态"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部", count: counts.missing + counts.grey },
            { value: "grey", label: "变灰", count: counts.grey },
            { value: "missing", label: "消失", count: counts.missing },
          ]}
        />
        <SearchBox value={query} onChange={setQuery} placeholder="搜索歌名、歌手或专辑" />
      </div>

      {loadState === "loading" ? <LoadingRows /> : null}
      {loadState === "unavailable" ? (
        <EmptyState
          unavailable
          title="守护服务还没有传来数据"
          body="界面已经就位。完成网易云授权并建立第一次快照后，真实的消失与变灰记录会出现在这里。"
          action={
            <button type="button" className="primary-button" onClick={onGoSync}>
              去同步状态 <span>→</span>
            </button>
          }
        />
      ) : null}
      {loadState === "ready" && visible.length === 0 ? (
        <EmptyState
          title={query || filter !== "all" ? "没有符合条件的歌曲" : "此刻没有待找回的歌曲"}
          body={
            query || filter !== "all"
              ? "换个关键词或状态看看。"
              : "安静是好消息。下一次扫描仍会继续替你守着。"
          }
        />
      ) : null}
      {loadState === "ready" && visible.length ? (
        <div className="recovery-list" role="list">
          <div className="list-header recovery-grid" aria-hidden="true">
            <span>歌曲</span>
            <span>状态</span>
            <span>最后正常</span>
            <span>发现时间</span>
            <span />
          </div>
          {visible.map((item) => (
            <article className="recovery-row recovery-grid" role="listitem" key={item.song.id}>
              <div className="song-cell">
                <SongCover song={item.song} />
                <div>
                  <h3>{item.song.title}</h3>
                  <p>{artistLine(item.song)}</p>
                  <small>{item.song.album}</small>
                </div>
              </div>
              <div><StatusBadge kind={item.kind} /></div>
              <time>{formatDateTime(item.lastNormalAt)}</time>
              <time>{formatDateTime(item.confirmedAt)}</time>
              <div className="row-actions">
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => onCopy(item, "title")}
                  aria-label={`复制歌名：${item.song.title}`}
                  title="复制歌名"
                >
                  ⧉ 歌名
                </button>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => onCopy(item, "title-artist")}
                  aria-label={`复制歌名及歌手：${item.song.title}`}
                  title="复制歌名及歌手"
                >
                  ⧉ 歌名＋歌手
                </button>
                {item.song.neteaseUrl ? (
                  <a href={item.song.neteaseUrl} target="_blank" rel="noreferrer" aria-label={`在网易云打开 ${item.song.title}`}>
                    ↗
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => onComplete(item)}
                  disabled={completingSongId === item.song.id}
                >
                  {completingSongId === item.song.id ? "处理中" : "完成"}
                </button>
              </div>
            </article>
          ))}
          <div className="load-sentinel">
            {loadingMore ? <span className="inline-loader">正在接入更多记录…</span> : null}
            {nextCursor && !loadingMore ? <button type="button" onClick={onLoadMore}>继续载入</button> : null}
            {!nextCursor && items.length ? <span>已呈现全部待找回记录</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LikesView({
  loadState,
  songs,
  total,
  viewMode,
  setViewMode,
  query,
  setQuery,
  nextCursor,
  loadingMore,
  sentinelRef,
  onLoadMore,
  onGoSync,
  playlist,
}: {
  loadState: LoadState;
  songs: SongRecord[];
  total?: number;
  viewMode: LibraryViewMode;
  setViewMode: (value: LibraryViewMode) => void;
  query: string;
  setQuery: (value: string) => void;
  nextCursor?: string;
  loadingMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  onGoSync: () => void;
  playlist?: SyncStatus["playlist"];
}) {
  const filtered = useMemo(
    () =>
      songs.filter((song) => includesSong(song, query)),
    [query, songs],
  );

  return (
    <div className="view-stack view-likes">
      <PageHeading
        eyebrow="THE LIVING ARCHIVE"
        title="歌单歌曲"
        description="当前绑定歌单的持续镜像。搜索与筛选基于真实同步数据，长列表会按需增量呈现。"
        right={
          <div className="library-total">
            <strong>{formatNumber(total ?? songs.length)}</strong>
            <span>TRACKS ARCHIVED</span>
          </div>
        }
      />
      <section className="library-marquee glass-panel">
        <div className="mini-disc" aria-hidden="true"><i /></div>
        <div>
          <p className="micro-label">PLAYLIST / {playlist?.id ?? "尚未绑定"}</p>
          <h2>{playlist?.name ?? "等待选择歌单"}</h2>
          {playlist && !playlist.owned ? <p>收藏自 {playlist.ownerName || "其他用户"}；对方修改歌单也会被记录为变化。</p> : null}
          <p>每一次新增都会进入快照；每一次异常都有据可查。</p>
        </div>
        <div className="marquee-wave" aria-hidden="true">
          {Array.from({ length: 32 }).map((_, index) => <i key={index} />)}
        </div>
      </section>
      <div className="toolbar glass-panel">
        <p className="toolbar-note">正常歌曲保持安静，异常歌曲会标出“已变灰”或“已消失”。</p>
        <div className="library-tools">
          <SearchBox value={query} onChange={setQuery} placeholder="在歌单里搜索" />
          <div className="view-switch" role="group" aria-label="歌单视图">
            <button type="button" className={viewMode === "list" ? "is-active" : ""} onClick={() => setViewMode("list")} aria-pressed={viewMode === "list"}>列表</button>
            <button type="button" className={viewMode === "grid" ? "is-active" : ""} onClick={() => setViewMode("grid")} aria-pressed={viewMode === "grid"}>封面</button>
          </div>
        </div>
      </div>

      {loadState === "loading" ? <LoadingRows count={7} /> : null}
      {loadState === "unavailable" ? (
        <EmptyState
          unavailable
          title="还没有建立歌单基线"
          body="连接网易云并选择歌单后，系统会先完整验证，再自动建立第一份基线。"
          action={
            <button type="button" className="primary-button" onClick={onGoSync}>
              建立第一次同步 <span>→</span>
            </button>
          }
        />
      ) : null}
      {loadState === "ready" && filtered.length === 0 ? (
        <EmptyState
          title={songs.length ? "没有符合条件的歌曲" : "歌单快照还是空的"}
          body={songs.length ? "换个关键词或筛选条件试试。" : "下一次成功同步会把当前歌单歌曲带到这里。"}
        />
      ) : null}
      {loadState === "ready" && filtered.length ? (
        <section className={`likes-table view-${viewMode}`}>
          {viewMode === "list" ? (
            <div className="list-header likes-grid" aria-hidden="true">
              <span>#</span><span>歌曲</span><span>专辑</span><span>状态</span><span>最近确认</span><span />
            </div>
          ) : null}
          <div className={viewMode === "grid" ? "likes-cover-grid" : "likes-list"} role="list">
            {filtered.map((song, index) => viewMode === "grid" ? (
              <article className={`like-cover-card ${song.state === "grey" ? "is-grey" : song.state === "missing" ? "is-missing" : ""}`} role="listitem" key={song.id}>
                <a href={song.neteaseUrl} target="_blank" rel="noreferrer" aria-label={`在网易云打开 ${song.title}`}>
                  <SongCover song={song} size="large" />
                  <span className="cover-open" aria-hidden="true">↗</span>
                </a>
                <h3>{song.title}</h3>
                <p>{artistLine(song)}</p>
                {song.state === "grey" ? <span className="library-state state-grey"><i />已变灰</span> : null}
                {song.state === "missing" ? <span className="library-state state-missing"><i />已消失</span> : null}
              </article>
            ) : (
              <article className="like-row likes-grid" role="listitem" key={song.id}>
                <span className="track-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="song-cell">
                  <SongCover song={song} />
                  <div><h3>{song.title}</h3><p>{artistLine(song)}</p></div>
                </div>
                <p className="album-cell">{song.album}</p>
                {song.state === "grey" ? <span className="library-state state-grey"><i />已变灰</span> : song.state === "missing" ? <span className="library-state state-missing"><i />已消失</span> : <span />}
                <time>{formatDateTime(song.lastSeenAt)}</time>
                {song.neteaseUrl ? (
                  <a className="song-open" href={song.neteaseUrl} target="_blank" rel="noreferrer" aria-label={`在网易云打开 ${song.title}`}>↗</a>
                ) : <span />}
              </article>
            ))}
          </div>
          <div className="load-sentinel" ref={sentinelRef}>
            {loadingMore ? <span className="inline-loader">正在接入下一段回声…</span> : null}
            {nextCursor && !loadingMore ? (
              <button type="button" onClick={onLoadMore}>继续载入</button>
            ) : null}
            {!nextCursor && songs.length ? (
              <span>已呈现 {formatNumber(songs.length)}{total ? ` / ${formatNumber(total)}` : ""} 首</span>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SyncView({
  status,
  loadState,
  loadError,
  syncing,
  onSync,
  onLogin,
  onReauthorize,
  onRebind,
}: {
  status?: SyncStatus;
  loadState: LoadState;
  loadError?: RequestJsonError;
  syncing: boolean;
  onSync: () => void;
  onLogin: () => void;
  onReauthorize: () => void;
  onRebind: () => void;
}) {
  const currentPhase = phaseIndex(status?.phase);
  const isActive = status?.state === "running" || status?.state === "queued";
  const steps = ["验证会话", "读取歌单", "检查歌曲", "比对快照", "安全入库"];
  const sessionGood = status?.sessionStatus === "valid";
  const configured = status?.setupState === "ready" && Boolean(status.playlist);
  const progressStyle = status?.progress !== undefined
    ? ({ "--progress": `${Math.max(0, Math.min(1, status.progress)) * 100}%` } as CSSProperties)
    : undefined;
  const accessLocked = loadError?.code === "ACCESS_DENIED";

  return (
    <div className="view-stack view-sync">
      <PageHeading
        eyebrow="KEEP THE BEAT ALIVE"
        title="同步状态"
        description="查看每日守护是否正常、网易云登录态是否有效，并在需要时手动发起同步。"
        right={
          <button type="button" className="primary-button sync-button" disabled={!configured || !sessionGood || syncing || isActive} onClick={onSync}>
            <span className={syncing || isActive ? "spin-glyph" : ""}>↻</span>
            {syncing || isActive ? "正在同步" : "立即同步"}
          </button>
        }
      />

      {loadState === "loading" ? <LoadingRows count={4} /> : null}
      {loadState === "unavailable" ? (
        <EmptyState
          unavailable
          title={accessLocked ? "还差一步：配置 Cloudflare Access" : "状态服务还没有回应"}
          body={accessLocked
            ? "当前实例保持锁定，网易登录和 D1 业务接口均不可访问。请为 workers.dev 启用 Access，并配置允许邮箱、团队域名和 Audience。"
            : "前端已经准备好连接 Worker。后端路由部署完成后，这里会显示真实的同步进度与网易云登录态。"}
          action={accessLocked ? (
            <a
              className="primary-button"
              href="https://github.com/ZeroEthereal/needle-drop-archive/blob/main/DEPLOYMENT.md#cloudflare-access-收尾"
              target="_blank"
              rel="noreferrer"
            >查看 Access 收尾步骤 <span>→</span></a>
          ) : <button type="button" className="primary-button" onClick={onLogin}>连接网易云 <span>→</span></button>}
        />
      ) : null}
      {loadState === "ready" && status ? (
        <>
          <section className={`sync-console state-${status.state}`}>
            <div className="console-head">
              <div>
                <span className="console-kicker"><i /> SYSTEM PULSE</span>
                <h2>{isActive ? "正在同步中" : syncLabel(status)}</h2>
                <p>{status.phase || (status.lastSuccessAt ? `最近成功于 ${formatDateTime(status.lastSuccessAt)}` : "准备建立第一张歌单快照")}</p>
              </div>
              <div className="pulse-core" aria-hidden="true"><i /><span /></div>
            </div>
            <div className={`sync-progress ${status.progress === undefined && isActive ? "is-indeterminate" : ""}`} style={progressStyle}><i /></div>
            <div className="sync-steps">
              {steps.map((step, index) => {
                const complete = status.state === "success" || (isActive && currentPhase > index);
                const active = isActive && (currentPhase === index || (currentPhase < 0 && index === 0));
                return (
                  <div className={`${complete ? "is-complete" : ""} ${active ? "is-active" : ""}`} key={step}>
                    <span>{complete ? "✓" : String(index + 1).padStart(2, "0")}</span>
                    <p>{step}</p>
                  </div>
                );
              })}
            </div>
            {status.error ? <div className="sync-error"><strong>{status.state === "reauth_required" ? "需要重新授权网易云" : "同步没有完成"}</strong><p>{status.error}</p></div> : null}
          </section>

          <section className="sync-metrics">
            <article className="metric-card accent-cyan">
              <p>{status.playlist?.name ?? "歌单歌曲"}</p><strong>{formatNumber(status.totalSongCount)}</strong><span>正常、变灰与消失的总和</span>
            </article>
            <article className="metric-card accent-lime">
              <p>正常播放</p><strong>{formatNumber(status.normalCount)}</strong><span>本轮确认可以正常播放</span>
            </article>
            <article className="metric-card accent-violet">
              <p>变灰</p><strong>{formatNumber(status.greyCount)}</strong><span>仍在歌单但不可播放</span>
            </article>
            <article className="metric-card accent-red">
              <p>消失</p><strong>{formatNumber(status.missingCount)}</strong><span>被用户删除或被官方下架</span>
            </article>
          </section>

          <section className="connection-grid">
            <article className="connection-card glass-panel">
              <div className="connection-icon netease-icon" aria-hidden="true"><span>♪</span></div>
              <div className="connection-copy">
                <p className="micro-label">NETEASE SESSION</p>
                <h3>{status.profile?.nickname || "网易云登录态"}</h3>
                <span className={`connection-state ${sessionGood ? "is-good" : "is-warn"}`}><i />{sessionLabel(status.sessionStatus)}</span>
                <p>{sessionGood ? "定时任务会复用加密会话；无需每天手动登录。" : "扫描一次二维码即可授权。会话失效时系统会提醒你重新登录。"}</p>
              </div>
              <div className="connection-actions">
                {configured ? (
                  <>
                    <button type="button" className="quiet-button" onClick={onReauthorize}>重新授权</button>
                    <button type="button" disabled={!sessionGood} onClick={onRebind}>重绑歌单</button>
                  </>
                ) : (
                  <button type="button" onClick={onLogin}>连接网易云</button>
                )}
              </div>
            </article>
          </section>

          {status.binding ? (
            <section className="sync-error">
              <strong>{status.binding.state === "failed" ? "新歌单没有切换" : "正在为新歌单建立安全基线"}</strong>
              <p>{status.binding.error?.message ?? "完成前会继续使用原账号、原歌单和原历史。"}</p>
            </section>
          ) : null}

          <section className="schedule-card glass-panel">
            <div><p className="micro-label">LAST CLEAN SYNC</p><strong>{formatDateTime(status.lastSuccessAt)}</strong></div>
            <i aria-hidden="true" />
            <div><p className="micro-label">NEXT AUTOMATIC RUN</p><strong>{status.nextRunAt ? formatDateTime(status.nextRunAt) : "等待计划任务"}</strong></div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function QrModal({
  login,
  onClose,
  onRefresh,
}: {
  login?: QrLogin;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const stateCopy: Record<QrLoginState, string> = {
    creating: "正在生成安全二维码…",
    waiting_scan: "请用网易云音乐 App 扫码",
    waiting_confirm: "已扫码，请在手机上确认",
    authorized: "授权成功，正在连接守护服务",
    expired: "二维码已经过期",
    error: "暂时无法生成二维码",
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title">
        <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        <p className="micro-label">SECURE NETEASE LINK</p>
        <h2 id="qr-title">连接网易云</h2>
        <p className="qr-intro">只需首次扫码。登录态会在服务端加密保存，之后每天自动同步；失效时才需要重新授权。</p>
        <div className={`qr-stage state-${login?.state ?? "creating"}`}>
          <div className="scan-corners" aria-hidden="true"><i /><i /><i /><i /></div>
          {login?.qrImage ? (
            // The same-origin Worker renders this SVG; no plaintext challenge is exposed as a link or JSON field.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={login.qrImage} alt="网易云登录二维码" />
          ) : (
            <div className="qr-loader"><i /><span>♪</span></div>
          )}
          {login?.state === "waiting_scan" ? <div className="scan-line" /> : null}
        </div>
        <div className={`qr-status status-${login?.state ?? "creating"}`}><i />{login?.message || stateCopy[login?.state ?? "creating"]}</div>
        <ol className="qr-help"><li>打开网易云音乐 App</li><li>搜索框右侧打开扫一扫</li><li>扫码并在手机上确认</li></ol>
        {login?.state === "expired" || login?.state === "error" ? <button type="button" className="primary-button qr-refresh" onClick={onRefresh}>重新生成</button> : null}
      </section>
    </div>
  );
}

function PlaylistModal({
  playlists,
  loading,
  binding,
  onSelect,
  onClose,
}: {
  playlists: PlaylistChoice[];
  loading: boolean;
  binding: boolean;
  onSelect: (playlist: PlaylistChoice) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card playlist-picker" role="dialog" aria-modal="true" aria-labelledby="playlist-title">
        <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        <p className="micro-label">CHOOSE ONE PLAYLIST</p>
        <h2 id="playlist-title">选择要守护的歌单</h2>
        <p className="qr-intro">只长期保存最终选择。收藏的他人歌单会标出所有者，对方修改也会被记录为变化。</p>
        {loading && playlists.length === 0 ? <div className="qr-loader"><i /><span>♪</span></div> : null}
        {!loading && playlists.length === 0 ? <p className="playlist-picker-empty">没有找到可建立基线的非空歌单。</p> : null}
        <div className="playlist-choice-list">
          {playlists.map((playlist) => (
            <button type="button" key={playlist.id} disabled={binding || playlist.trackCount === 0} onClick={() => onSelect(playlist)}>
              {playlist.coverUrl ? (
                // Playlist covers are remote user data; the Worker image route is not guaranteed for every host.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={playlist.coverUrl} alt="" />
              ) : <span className="playlist-choice-cover">♪</span>}
              <span><strong>{playlist.name}</strong><small>{playlist.owned ? "我的歌单" : `收藏自 ${playlist.ownerName}`}{playlist.private ? " · 私密" : ""} · {playlist.trackCount} 首</small></span>
              <i>→</i>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function MusicVault() {
  const [view, setView] = useState<ViewId>("recovery");
  const [motion, setMotion] = useState<MotionMode>("immersive");
  const [recoveryItems, setRecoveryItems] = useState<RecoveryItem[]>([]);
  const [recoveryCursor, setRecoveryCursor] = useState<string>();
  const [loadingMoreRecovery, setLoadingMoreRecovery] = useState(false);
  const [recoveryState, setRecoveryState] = useState<LoadState>("loading");
  const [recoveryFilter, setRecoveryFilter] = useState<RecoveryFilter>("all");
  const [recoveryQuery, setRecoveryQuery] = useState("");
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [likesState, setLikesState] = useState<LoadState>("loading");
  const [libraryView, setLibraryView] = useState<LibraryViewMode>("list");
  const [likesQuery, setLikesQuery] = useState("");
  const [likesTotal, setLikesTotal] = useState<number>();
  const [likesCursor, setLikesCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState<SyncStatus>();
  const [statusState, setStatusState] = useState<LoadState>("loading");
  const [statusError, setStatusError] = useState<RequestJsonError>();
  const [syncing, setSyncing] = useState(false);
  const [completingSongId, setCompletingSongId] = useState<string>();
  const [qrOpen, setQrOpen] = useState(false);
  const [qrLogin, setQrLogin] = useState<QrLogin>();
  const [qrMode, setQrMode] = useState<"initial" | "reauthorize">("initial");
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistBinding, setPlaylistBinding] = useState(false);
  const [playlistChoices, setPlaylistChoices] = useState<PlaylistChoice[]>([]);
  const [playlistFlowId, setPlaylistFlowId] = useState<string>();
  const [toast, setToast] = useState<Toast>();
  const [backgrounded, setBackgrounded] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const likesSentinelRef = useRef<HTMLDivElement>(null);
  const recoveryRequest = useRef(0);
  const likesRequest = useRef(0);
  const recoverySearch = useDebounced(recoveryQuery);
  const likesSearch = useDebounced(likesQuery);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem("echo-vault-motion") as MotionMode | null;
      if (saved && motionOptions.some((option) => option.id === saved)) {
        setMotion(saved);
      } else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setMotion("static");
      } else if ((navigator.hardwareConcurrency || 8) <= 4) {
        setMotion("balanced");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const update = () => setBackgrounded(document.visibilityState !== "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("echo-vault-motion", motion);
  }, [motion]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!qrOpen && !playlistOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setQrOpen(false);
      setPlaylistOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [playlistOpen, qrOpen]);

  const loadRecovery = useCallback(async (cursor?: string, append = false) => {
    const sequence = append ? recoveryRequest.current : ++recoveryRequest.current;
    if (append) setLoadingMoreRecovery(true);
    else setRecoveryState("loading");
    const params = new URLSearchParams({ limit: "100" });
    if (recoveryFilter !== "all") params.set("type", recoveryFilter);
    if (recoverySearch.trim()) params.set("query", recoverySearch.trim());
    if (cursor) params.set("cursor", cursor);
    try {
      const raw = await requestJson([{ url: `/api/recovery?${params}` }]);
      if (sequence !== recoveryRequest.current) return;
      const page = normalizePage(raw, normalizeRecovery);
      setRecoveryItems((current) => {
        if (!append) return page.items;
        const known = new Set(current.map((item) => item.song.id));
        return [...current, ...page.items.filter((item) => !known.has(item.song.id))];
      });
      setRecoveryCursor(page.nextCursor);
      setRecoveryState("ready");
    } catch {
      if (sequence !== recoveryRequest.current) return;
      if (!append) {
        setRecoveryItems([]);
        setRecoveryCursor(undefined);
        setRecoveryState("unavailable");
      } else {
        notify("更多待找回记录暂时没有载入，请稍后再试。", "bad");
      }
    } finally {
      setLoadingMoreRecovery(false);
    }
  }, [notify, recoveryFilter, recoverySearch]);

  const loadLikes = useCallback(async (cursor?: string, append = false) => {
    const sequence = append ? likesRequest.current : ++likesRequest.current;
    if (append) setLoadingMore(true);
    else setLikesState("loading");
    const params = new URLSearchParams({ limit: String(LIKES_PAGE_SIZE) });
    if (likesSearch.trim()) params.set("query", likesSearch.trim());
    if (cursor) params.set("cursor", cursor);
    try {
      const raw = await requestJson([{ url: `/api/likes?${params}` }]);
      if (sequence !== likesRequest.current) return;
      const page = normalizePage(raw, (item) => normalizeSong(item));
      setSongs((current) => {
        if (!append) return page.items;
        const known = new Set(current.map((song) => song.id));
        return [...current, ...page.items.filter((song) => !known.has(song.id))];
      });
      setLikesCursor(page.nextCursor);
      setLikesTotal(page.total);
      setLikesState("ready");
    } catch {
      if (!append) {
        setSongs([]);
        setLikesState("unavailable");
      } else {
        notify("下一段歌单暂时没有载入，请稍后再试。", "bad");
      }
    } finally {
      setLoadingMore(false);
    }
  }, [likesSearch, notify]);

  const loadStatus = useCallback(async (showLoading = false) => {
    if (showLoading) setStatusState("loading");
    try {
      const raw = await requestJson([{ url: "/api/sync/status" }]);
      setStatus(normalizeStatus(raw));
      setStatusError(undefined);
      setStatusState("ready");
    } catch (error) {
      setStatus(undefined);
      setStatusError(error instanceof RequestJsonError ? error : undefined);
      setStatusState("unavailable");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRecovery(undefined, false), 0);
    return () => window.clearTimeout(timer);
  }, [loadRecovery]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadLikes(undefined, false), 0);
    return () => window.clearTimeout(timer);
  }, [loadLikes]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(true), 0);
    return () => window.clearTimeout(timer);
  }, [loadStatus]);

  const refreshedForSyncAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    const completedAt = status?.lastSuccessAt;
    if (!completedAt || refreshedForSyncAt.current === completedAt) return;
    refreshedForSyncAt.current = completedAt;
    void loadLikes(undefined, false);
    void loadRecovery(undefined, false);
  }, [loadLikes, loadRecovery, status?.lastSuccessAt]);

  useEffect(() => {
    const bindingActive = status?.binding?.state === "preparing" || status?.binding?.state === "running";
    if (status?.state !== "running" && status?.state !== "queued" && !bindingActive) return;
    const timer = window.setInterval(() => void loadStatus(false), 800);
    return () => window.clearInterval(timer);
  }, [loadStatus, status?.binding?.state, status?.state]);

  const loadMoreLikes = useCallback(() => {
    if (!likesCursor || loadingMore) return;
    void loadLikes(likesCursor, true);
  }, [likesCursor, loadLikes, loadingMore]);

  const loadMoreRecovery = useCallback(() => {
    if (!recoveryCursor || loadingMoreRecovery) return;
    void loadRecovery(recoveryCursor, true);
  }, [loadRecovery, loadingMoreRecovery, recoveryCursor]);

  useEffect(() => {
    const node = likesSentinelRef.current;
    if (!node || !likesCursor || view !== "likes") return;
    const observer = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && loadMoreLikes(),
      { rootMargin: "500px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [likesCursor, loadMoreLikes, view]);

  const handleMotion = (value: MotionMode) => setMotion(value);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (motion === "static" || !appRef.current) return;
    const x = event.clientX / window.innerWidth - 0.5;
    const y = event.clientY / window.innerHeight - 0.5;
    appRef.current.style.setProperty("--pointer-x", `${x * 20}px`);
    appRef.current.style.setProperty("--pointer-y", `${y * 20}px`);
  };

  const handleComplete = async (item: RecoveryItem) => {
    if (completingSongId) return;
    setCompletingSongId(item.song.id);
    try {
      const raw = await requestJson([
        { url: `/api/recovery/${encodeURIComponent(item.song.id)}/complete`, init: { method: "POST" } },
      ]);
      const result = unwrap(raw);
      const restored = isRecord(result) && result.restored === true;
      if (restored) {
        notify("歌曲已恢复正常", "info");
      } else {
        setRecoveryItems((current) => current.filter((row) => row.song.id !== item.song.id));
        setSongs((current) => current.filter((song) => song.id !== item.song.id));
        notify("已处理", "good");
      }
      void Promise.all([
        loadRecovery(undefined, false),
        loadLikes(undefined, false),
        loadStatus(false),
      ]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "暂时无法完成这条记录。", "bad");
    } finally {
      setCompletingSongId(undefined);
    }
  };

  const handleCopySong = useCallback(async (
    item: RecoveryItem,
    mode: "title" | "title-artist",
  ) => {
    const titleOnly = mode === "title";
    const value = titleOnly
      ? item.song.title
      : `${item.song.title} - ${artistLine(item.song)}`;
    try {
      await copyToClipboard(value);
      notify(titleOnly ? "已复制歌名" : "已复制歌名及歌手", "good");
    } catch {
      notify("复制失败，请稍后再试。", "bad");
    }
  }, [notify]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await requestJson([{ url: "/api/sync", init: { method: "POST" } }]);
      setStatus((current) => current ? { ...current, state: "queued", phase: "同步任务已进入队列" } : current);
      notify("同步任务已经开始，页面会自动更新进度。", "good");
      window.setTimeout(() => void loadStatus(false), 900);
    } catch (error) {
      notify(error instanceof Error ? error.message : "同步任务没有启动。", "bad");
    } finally {
      setSyncing(false);
    }
  };

  const cancelFlow = useCallback(async (flowId?: string) => {
    if (!flowId) return;
    await requestJson([{
      url: `/api/netease/auth-flows/${encodeURIComponent(flowId)}/cancel`,
      init: { method: "POST", body: "{}" },
    }]).catch(() => undefined);
  }, []);

  const loadPlaylists = useCallback(async (flowId?: string) => {
    setPlaylistOpen(true);
    setPlaylistLoading(true);
    setPlaylistChoices([]);
    setPlaylistFlowId(flowId);
    try {
      const items = new Map<string, PlaylistChoice>();
      let offset = 0;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const raw = unwrap(await requestJson([{
          url: "/api/netease/playlists",
          init: { method: "POST", body: JSON.stringify({ flowId, offset, limit: 100 }) },
        }]));
        const record = isRecord(raw) ? raw : {};
        const pageItems = Array.isArray(record.items) ? record.items : [];
        let addedOnThisPage = 0;
        for (const value of pageItems) {
          if (!isRecord(value)) continue;
          const id = firstString(value.id);
          const name = firstString(value.name);
          const ownerUid = firstString(value.ownerUid);
          if (!id || !name || !ownerUid) continue;
          if (items.has(id)) continue;
          items.set(id, {
            id,
            name,
            coverUrl: firstString(value.coverUrl),
            trackCount: firstNumber(value.trackCount) ?? 0,
            ownerUid,
            ownerName: firstString(value.ownerName) ?? "未知所有者",
            owned: value.owned === true,
            private: value.private === true,
          });
          addedOnThisPage += 1;
        }
        const nextOffset = firstNumber(record.nextOffset);
        const total = firstNumber(record.total);
        if (total !== undefined && items.size >= total) break;
        if (pageItems.length === 0 || addedOnThisPage === 0) break;
        if (nextOffset === undefined || nextOffset <= offset) break;
        offset = nextOffset;
      }
      setPlaylistChoices([...items.values()]);
    } catch (error) {
      setPlaylistChoices([]);
      notify(error instanceof Error ? error.message : "歌单列表读取失败。", "bad");
    } finally {
      setPlaylistLoading(false);
    }
  }, [notify]);

  const createQr = useCallback(async (mode: "initial" | "reauthorize" = qrMode) => {
    setQrMode(mode);
    setQrLogin({ flowId: "", state: "creating" });
    try {
      const raw = unwrap(await requestJson([
        { url: "/api/netease/auth-flows", init: { method: "POST", body: JSON.stringify({ mode }) } },
      ]));
      const record = isRecord(raw) ? raw : {};
      const flowId = firstString(record.id, record.flowId);
      const qrImageUrl = firstString(record.qrImageUrl);
      if (!flowId || !qrImageUrl || !qrImageUrl.startsWith("/api/netease/auth-flows/")) {
        throw new Error("二维码响应不完整");
      }
      setQrLogin({
        flowId,
        qrImage: qrImageUrl,
        expiresAt: firstString(record.expiresAt, record.expireAt),
        state: "waiting_scan",
      });
    } catch (error) {
      setQrLogin({
        flowId: "",
        state: "error",
        message: error instanceof Error ? error.message : "暂时无法生成二维码",
      });
    }
  }, [qrMode]);

  const openQr = (mode: "initial" | "reauthorize" = "initial") => {
    setQrOpen(true);
    void createQr(mode);
  };

  const closeQr = () => {
    void cancelFlow(qrLogin?.flowId);
    setQrOpen(false);
  };

  const closePlaylistPicker = () => {
    if (!playlistBinding) void cancelFlow(playlistFlowId);
    setPlaylistOpen(false);
  };

  useEffect(() => {
    if (!qrOpen || !qrLogin?.flowId || !["waiting_scan", "waiting_confirm"].includes(qrLogin.state)) return;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const raw = unwrap(await requestJson([
          { url: `/api/netease/auth-flows/${encodeURIComponent(qrLogin.flowId)}/poll`, init: { method: "POST", body: "{}" } },
        ]));
        const record = isRecord(raw) ? raw : {};
        const rawState = firstString(record.state, record.status);
        const state = rawState === "same_account_authorized" ? "authorized" : qrState(rawState ?? record.code);
        setQrLogin((current) => current ? { ...current, state, message: firstString(record.message, record.reason) } : current);
        if (state === "authorized") {
          const requiresSelection = record.requiresPlaylistSelection === true;
          notify(requiresSelection ? "登录成功，请选择要守护的歌单。" : "重新授权成功，原歌单和全部历史已保留。", "good");
          void loadStatus(false);
          setQrOpen(false);
          if (requiresSelection) void loadPlaylists(qrLogin.flowId);
        }
      } catch {
        // A transient poll failure should not destroy a still-valid QR code.
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void check(), 1900);
    void check();
    return () => window.clearInterval(timer);
  }, [loadPlaylists, loadStatus, notify, qrLogin?.flowId, qrLogin?.state, qrOpen]);

  const bindPlaylist = async (playlist: PlaylistChoice) => {
    const warning = playlist.owned
      ? `确定改为监控“${playlist.name}”吗？新基线成功后，旧歌单的活动历史会被清除。`
      : `“${playlist.name}”属于 ${playlist.ownerName}。对方修改也会被记录；新基线成功后旧历史会被清除。确定继续吗？`;
    if (!window.confirm(warning)) return;
    setPlaylistBinding(true);
    try {
      await requestJson([{
        url: "/api/playlist-binding",
        init: { method: "POST", body: JSON.stringify({ flowId: playlistFlowId, playlistId: playlist.id }) },
      }]);
      setPlaylistOpen(false);
      notify("正在完整读取新歌单；完成前旧配置继续有效。", "good");
      void loadStatus(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "歌单基线任务没有启动。", "bad");
    } finally {
      setPlaylistBinding(false);
    }
  };

  const pendingCount = status
    ? status.missingCount !== undefined || status.greyCount !== undefined
      ? (status.missingCount ?? 0) + (status.greyCount ?? 0)
      : undefined
    : recoveryState === "ready"
      ? recoveryItems.length
      : undefined;

  return (
    <div
      className={`echo-app motion-${motion}`}
      ref={appRef}
      onPointerMove={handlePointerMove}
      data-view={view}
      data-backgrounded={backgrounded ? "true" : "false"}
    >
      <AmbientStage motion={motion} />
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-disc" aria-hidden="true"><i /><span /></div>
          <div><strong>NEEDLE DROP</strong><span>拾针 · 音乐防丢台</span></div>
        </div>
        <nav aria-label="主导航">
          {navItems.map((item) => (
            <button type="button" key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)} aria-current={view === item.id ? "page" : undefined}>
              <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
              <span><small>{item.eyebrow}</small>{item.label}</span>
              {item.id === "recovery" && pendingCount ? <b>{pendingCount}</b> : null}
              <i aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="motion-control">
          <p>舞台动态</p>
          <div role="group" aria-label="动态效果强度">
            {motionOptions.map((option) => (
              <button type="button" key={option.id} className={motion === option.id ? "is-active" : ""} onClick={() => handleMotion(option.id)} aria-pressed={motion === option.id}>{option.label}</button>
            ))}
          </div>
        </div>
        <div className="playlist-stamp"><span>PLAYLIST</span><strong>{status?.playlist?.id ?? "未绑定"}</strong></div>
      </aside>

      <main>
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-disc"><i /><b /></span><strong>拾针</strong></div>
          <div className={`global-health state-${status?.state ?? "unknown"}`}>
            <span className="live-dot" />
            <p><small>SYSTEM STATUS</small>{syncLabel(status)}</p>
          </div>
          <div className="topbar-meta">
            <p><small>LAST SYNC</small>{status?.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : "等待首次同步"}</p>
            <button type="button" className="compact-motion" onClick={() => handleMotion(motion === "immersive" ? "balanced" : motion === "balanced" ? "static" : "immersive")} aria-label="切换动态效果">✦</button>
          </div>
        </header>

        <div className="content-stage">
          {view === "recovery" ? (
            <RecoveryView
              status={status}
              loadState={recoveryState}
              items={recoveryItems}
              filter={recoveryFilter}
              setFilter={setRecoveryFilter}
              query={recoveryQuery}
              setQuery={setRecoveryQuery}
              onComplete={handleComplete}
              onCopy={handleCopySong}
              completingSongId={completingSongId}
              nextCursor={recoveryCursor}
              loadingMore={loadingMoreRecovery}
              onLoadMore={loadMoreRecovery}
              onGoSync={() => setView("sync")}
            />
          ) : null}
          {view === "likes" ? (
            <LikesView
              loadState={likesState}
              songs={songs}
              total={likesTotal ?? status?.totalSongCount}
              viewMode={libraryView}
              setViewMode={setLibraryView}
              query={likesQuery}
              setQuery={setLikesQuery}
              nextCursor={likesCursor}
              loadingMore={loadingMore}
              sentinelRef={likesSentinelRef}
              onLoadMore={loadMoreLikes}
              onGoSync={() => setView("sync")}
              playlist={status?.playlist}
            />
          ) : null}
          {view === "sync" ? (
            <SyncView
              status={status}
              loadState={statusState}
              loadError={statusError}
              syncing={syncing}
              onSync={handleSync}
              onLogin={() => openQr("initial")}
              onReauthorize={() => openQr("reauthorize")}
              onRebind={() => void loadPlaylists()}
            />
          ) : null}
        </div>
      </main>

      <nav className="mobile-nav" aria-label="移动端主导航">
        {navItems.map((item) => (
          <button type="button" key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)} aria-current={view === item.id ? "page" : undefined}>
            <span aria-hidden="true">{item.glyph}</span><small>{item.label}</small>
            {item.id === "recovery" && pendingCount ? <b>{pendingCount}</b> : null}
          </button>
        ))}
      </nav>

      {qrOpen ? <QrModal login={qrLogin} onClose={closeQr} onRefresh={() => {
        void cancelFlow(qrLogin?.flowId).finally(() => createQr());
      }} /> : null}
      {playlistOpen ? (
        <PlaylistModal
          playlists={playlistChoices}
          loading={playlistLoading}
          binding={playlistBinding}
          onSelect={(playlist) => void bindPlaylist(playlist)}
          onClose={closePlaylistPicker}
        />
      ) : null}
      {toast ? <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite"><i />{toast.message}</div> : null}
    </div>
  );
}
