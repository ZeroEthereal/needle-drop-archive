import { NeteaseError } from "./errors.ts";

interface SessionData {
  cookies: Map<string, string>;
  createdAt: number;
  updatedAt: number;
}

interface SerializedSessionV1 {
  version: 1;
  createdAt: number;
  updatedAt: number;
  cookies: Array<[string, string]>;
}

const SESSION_TOKEN = Symbol("netease-session-token");
const SESSION_DATA = new WeakMap<NeteaseSession, SessionData>();
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Opaque authenticated state. Cookie material lives in a WeakMap and is not an
 * enumerable property. JSON serialization is intentionally redacted.
 */
export class NeteaseSession {
  constructor(token: symbol, data: SessionData) {
    if (token !== SESSION_TOKEN) {
      throw new TypeError("NeteaseSession must be created by the session helpers");
    }
    SESSION_DATA.set(this, data);
    Object.freeze(this);
  }

  toJSON(): Record<string, unknown> {
    const data = getData(this);
    return {
      redacted: true,
      createdAt: new Date(data.createdAt).toISOString(),
      updatedAt: new Date(data.updatedAt).toISOString(),
    };
  }
}

function getData(session: NeteaseSession): SessionData {
  const data = SESSION_DATA.get(session);
  if (!data) {
    throw new TypeError("Invalid NeteaseSession handle");
  }
  return data;
}

function safeCookiePair(name: string, value: string): [string, string] | null {
  const normalizedName = name.trim();
  const normalizedValue = value.trim();
  if (!COOKIE_NAME.test(normalizedName) || /[\r\n;]/.test(normalizedValue)) {
    return null;
  }
  return [normalizedName, normalizedValue];
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const pair = safeCookiePair(part.slice(0, separator), part.slice(separator + 1));
    if (pair) cookies.set(pair[0], pair[1]);
  }
  return cookies;
}

export function createNeteaseSession(cookieHeader: string, now = Date.now()): NeteaseSession {
  const cookies = parseCookieHeader(cookieHeader);
  if (cookies.size === 0) {
    throw new NeteaseError("authentication", "The login response contained no usable session cookies");
  }
  return new NeteaseSession(SESSION_TOKEN, { cookies, createdAt: now, updatedAt: now });
}

/**
 * Returns plaintext secret material solely for immediate encryption by the
 * caller's vault. Never send this value to a browser, log, or email.
 */
export function serializeNeteaseSession(session: NeteaseSession): string {
  const data = getData(session);
  const payload: SerializedSessionV1 = {
    version: 1,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    cookies: [...data.cookies.entries()],
  };
  return JSON.stringify(payload);
}

export function deserializeNeteaseSession(serialized: string): NeteaseSession {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw new NeteaseError("authentication", "Stored NetEase session is not valid JSON", { cause });
  }

  if (!value || typeof value !== "object") {
    throw new NeteaseError("authentication", "Stored NetEase session has an invalid shape");
  }
  const parsed = value as Partial<SerializedSessionV1>;
  if (
    parsed.version !== 1 ||
    !Number.isFinite(parsed.createdAt) ||
    !Number.isFinite(parsed.updatedAt) ||
    !Array.isArray(parsed.cookies)
  ) {
    throw new NeteaseError("authentication", "Stored NetEase session has an unsupported version or shape");
  }

  const cookies = new Map<string, string>();
  for (const entry of parsed.cookies) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new NeteaseError("authentication", "Stored NetEase session contains an invalid cookie entry");
    }
    const pair = safeCookiePair(String(entry[0]), String(entry[1]));
    if (!pair) {
      throw new NeteaseError("authentication", "Stored NetEase session contains an unsafe cookie entry");
    }
    cookies.set(pair[0], pair[1]);
  }
  if (cookies.size === 0) {
    throw new NeteaseError("authentication", "Stored NetEase session is empty");
  }

  return new NeteaseSession(SESSION_TOKEN, {
    cookies,
    createdAt: parsed.createdAt as number,
    updatedAt: parsed.updatedAt as number,
  });
}

/** @internal Only the fixed-origin HTTP adapter should call this. */
export function sessionCookieHeader(session: NeteaseSession): string {
  return [...getData(session).cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function splitCombinedSetCookie(value: string): string[] {
  // Expires has a comma but no '=' after it; a new cookie starts with NAME=.
  return value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g).map((part) => part.trim()).filter(Boolean);
}

export function readSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  const modern = extended.getSetCookie?.();
  if (modern && modern.length > 0) return modern;
  const cloudflare = extended.getAll?.("Set-Cookie");
  if (cloudflare && cloudflare.length > 0) return cloudflare;
  const combined = headers.get("Set-Cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

/** Mutates only the WeakMap backing the opaque handle. */
export function mergeSessionSetCookies(session: NeteaseSession, setCookies: string[], now = Date.now()): boolean {
  const data = getData(session);
  let changed = false;
  for (const header of setCookies) {
    const segments = header.split(";").map((part) => part.trim());
    const first = segments[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const pair = safeCookiePair(first.slice(0, separator), first.slice(separator + 1));
    if (!pair) continue;

    const deleting = segments.some((segment) => /^max-age\s*=\s*0$/i.test(segment)) || segments.some((segment) => {
      const match = /^expires\s*=\s*(.+)$/i.exec(segment);
      return Boolean(match && Number.isFinite(Date.parse(match[1])) && Date.parse(match[1]) <= now);
    });
    if (deleting) {
      changed = data.cookies.delete(pair[0]) || changed;
      continue;
    }
    if (data.cookies.get(pair[0]) !== pair[1]) {
      data.cookies.set(pair[0], pair[1]);
      changed = true;
    }
  }
  if (changed) data.updatedAt = now;
  return changed;
}

export function sessionHasAuthentication(session: NeteaseSession): boolean {
  const cookies = getData(session).cookies;
  return cookies.has("MUSIC_U") || cookies.has("MUSIC_A");
}
