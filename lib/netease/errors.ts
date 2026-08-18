export type NeteaseErrorKind =
  | "timeout"
  | "network"
  | "http"
  | "rate_limited"
  | "api"
  | "authentication"
  | "anonymous"
  | "session_expired"
  | "risk_control"
  | "invalid_response"
  | "incomplete_response"
  | "uid_mismatch"
  | "unsupported_protocol";

export interface NeteaseErrorOptions {
  endpoint?: string;
  status?: number;
  apiCode?: number;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * Deliberately stores no response body, request headers, or cookie values.
 * It is safe to serialize for sync diagnostics.
 */
export class NeteaseError extends Error {
  readonly kind: NeteaseErrorKind;
  readonly endpoint: string | null;
  readonly status: number | null;
  readonly apiCode: number | null;
  readonly retryable: boolean;

  constructor(kind: NeteaseErrorKind, message: string, options: NeteaseErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "NeteaseError";
    this.kind = kind;
    this.endpoint = options.endpoint ?? null;
    this.status = options.status ?? null;
    this.apiCode = options.apiCode ?? null;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      endpoint: this.endpoint,
      status: this.status,
      apiCode: this.apiCode,
      retryable: this.retryable,
    };
  }
}
