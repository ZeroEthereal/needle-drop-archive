export interface WorkflowBinding<P = Record<string, unknown>> {
  create(options?: { id?: string; params?: P }): Promise<{ id: string }>;
  get(id: string): Promise<{
    status(): Promise<{ status: string; error?: { name: string; message: string } }>;
    sendEvent(options: { type: string; payload: unknown }): Promise<void>;
  }>;
}

export interface ImageBinding {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: {
        format: string;
        quality: number;
      }): Promise<{ response(): Response }>;
    };
  };
}

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES?: ImageBinding;
  MUSIC_SYNC?: WorkflowBinding<
    | { action?: "sync"; source: "manual" | "scheduled" }
    | { action: "bind_playlist"; bindingId: string }
    | { action: "sync_playlist"; batchId: string; playlistId: string }
    | { action: "prepare_playlist_baseline"; bindingId: string; playlistId: string }
  >;
  MUSIC_BATCH?: WorkflowBinding<
    | { action: "sync_batch"; batchId: string }
    | { action: "bind_playlist_set"; bindingId: string }
  >;

  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
  ALLOW_LOCAL_DEV?: string;

  SESSION_ENCRYPTION_KEY?: string;

  NETEASE_PLAYLIST_ID?: string;
  NETEASE_EXPECTED_UID?: string;
}

export interface AppExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
