export type RequestOption = { url: string; init?: RequestInit };

export class RequestJsonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = "RequestJsonError";
  }
}

export async function requestJson(options: RequestOption[]): Promise<unknown> {
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
            ? { "X-Requested-With": "ncm-archive" } : {}),
          ...option.init?.headers,
        },
      });
      const text = response.status === 204 ? "" : await response.text();
      if (!response.ok) {
        let message = text;
        let code: string | undefined;
        let retryAt: string | undefined;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            const detail = parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
            if (typeof detail.message === "string" && detail.message) message = detail.message;
            if (typeof detail.code === "string") code = detail.code;
            if (typeof detail.retryAt === "string") retryAt = detail.retryAt;
          }
        } catch { /* Preserve non-JSON errors, including Access responses. */ }
        lastError = new RequestJsonError(message || `请求失败（${response.status}）`, response.status, code, retryAt);
        continue;
      }
      return text ? JSON.parse(text) : {};
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
