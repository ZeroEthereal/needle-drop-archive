export type ViewId = "recovery" | "likes" | "sync";

export type MotionMode = "immersive" | "balanced" | "static";

export type RecoveryKind = "missing" | "grey";

export type SongState = "playable" | "grey" | "missing" | "unknown";

export interface SongRecord {
  id: string;
  title: string;
  artists: string[];
  album: string;
  coverUrl?: string;
  neteaseUrl?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastConfirmedAt?: string;
  state: SongState;
  source?: "catalog" | "cloud" | "unknown";
}

export interface RecoveryItem {
  kind: RecoveryKind;
  song: SongRecord;
  lastNormalAt?: string;
  confirmedAt?: string;
}

export type SessionStatus =
  | "valid"
  | "anonymous"
  | "expired"
  | "risk_controlled"
  | "unknown";

export type SyncState =
  | "idle"
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "reauth_required"
  | "unconfigured"
  | "unknown";

export interface SyncStatus {
  state: SyncState;
  phase?: string;
  lastSuccessAt?: string;
  nextRunAt?: string;
  totalSongCount?: number;
  normalCount?: number;
  missingCount?: number;
  greyCount?: number;
  sessionStatus: SessionStatus;
  error?: string;
  progress?: number;
  profile?: {
    userId?: string;
    nickname?: string;
    avatarUrl?: string;
  };
  setupState?: "unconfigured" | "ready" | "rebinding" | "error";
  bindingVersion?: number;
  playlist?: {
    id: string;
    name: string;
    coverUrl?: string;
    ownerUid?: string;
    ownerName?: string;
    owned: boolean;
    boundAt?: string;
  };
  binding?: {
    id: string;
    state: "preparing" | "running" | "failed";
    error?: { code: string; message: string };
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export type LoadState = "loading" | "ready" | "unavailable";

export type QrLoginState =
  | "creating"
  | "waiting_scan"
  | "waiting_confirm"
  | "authorized"
  | "expired"
  | "error";

export interface QrLogin {
  flowId: string;
  qrImage?: string;
  expiresAt?: string;
  state: QrLoginState;
  message?: string;
  requiresPlaylistSelection?: boolean;
}

export interface PlaylistChoice {
  id: string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  ownerUid: string;
  ownerName: string;
  owned: boolean;
  private: boolean;
}
