export type NeteaseQrState =
  | "waiting_scan"
  | "waiting_confirm"
  | "authorized"
  | "expired";

export type NeteaseLoginState =
  | "valid"
  | "anonymous"
  | "expired"
  | "risk_controlled";

export interface NeteaseProfile {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
}

export interface QrLoginChallenge {
  key: string;
  /** Content to encode locally as a QR code. It never contains a login cookie. */
  qrUrl: string;
  expiresAt: string;
}

export interface LoginStatus {
  state: NeteaseLoginState;
  profile: NeteaseProfile | null;
  accountId: string | null;
}

export interface RefreshResult {
  status: "refreshed" | "unchanged" | "reauth_required";
  login: LoginStatus;
}

export interface ArtistSummary {
  id: string | null;
  name: string;
}

export interface AlbumSummary {
  id: string | null;
  name: string | null;
  coverUrl: string | null;
}

export interface SongSummary {
  id: string;
  title: string;
  artists: ArtistSummary[];
  album: AlbumSummary;
  durationMs: number | null;
  fee: number | null;
  copyright: number | null;
  neteaseUrl: string;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  userId: string;
  ownerName: string;
  coverUrl: string | null;
  privacy: number | null;
  trackCount: number;
  cloudTrackCount: number;
  trackIds: string[];
  embeddedTracks: SongSummary[];
  updateTime: string | null;
}

export interface PlaylistPage {
  playlists: PlaylistDetail[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface CloudSong {
  id: string;
  title: string;
  artists: ArtistSummary[];
  album: AlbumSummary;
  fileName: string | null;
  addedAt: string | null;
  simpleSong: SongSummary | null;
}

export interface CloudSongPage {
  songs: CloudSong[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface SongDetailBatch {
  songs: SongSummary[];
  missingIds: string[];
}

export interface PlaybackAvailability {
  id: string;
  playable: boolean;
  code: number | null;
  /** A stable machine-readable hint only. The upstream playback URL is discarded. */
  reason:
    | "playable"
    | "no_url"
    | "not_found"
    | "payment_required"
    | "account_restricted"
    | "unknown";
  freeTrial: boolean;
}

export interface AccountSongSnapshot {
  id: string;
  song: SongSummary;
  playable: boolean;
  playbackCode: number | null;
  playbackReason: PlaybackAvailability["reason"];
  inCloud: boolean;
}

export interface AccountSnapshot {
  capturedAt: string;
  userId: string;
  playlist: PlaylistDetail;
  /** Canonical membership source: the selected playlist's complete trackIds. */
  trackIds: string[];
  cloudSongs: CloudSong[];
  songs: AccountSongSnapshot[];
  warnings: string[];
}

export interface AccountSnapshotOptions {
  playlistId: string;
  expectedUserId?: string;
  /** Defaults to true. Unexplained membership gaps abort rather than creating false loss events. */
  strictCompleteness?: boolean;
  /** Called after complete playlist membership has been read, before song inspection begins. */
  onPlaylistRead?: () => Promise<void> | void;
}

export interface NeteaseClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  retryCount?: number;
  detailBatchSize?: number;
  playbackBatchSize?: number;
  cloudPageSize?: number;
  /** Hard safety cap against malformed pagination. */
  maxCloudSongs?: number;
  qrTtlMs?: number;
  now?: () => number;
}
