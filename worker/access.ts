import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AccessDeniedError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AccessDeniedError";
    this.status = status;
  }
}

function normalizedTeamDomain(value: string): string {
  return value.startsWith("https://") ? value.replace(/\/$/, "") : `https://${value.replace(/\/$/, "")}`;
}

function getEmail(payload: JWTPayload): string | null {
  const email = payload.email;
  return typeof email === "string" && email.includes("@") ? email.toLowerCase() : null;
}

function isLocalBypass(request: Request, env: Env): boolean {
  const hostname = new URL(request.url).hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return isLocal && env.ALLOW_LOCAL_DEV !== "false";
}

export async function requireAccessIdentity(
  request: Request,
  env: Env,
): Promise<{ email: string; local: boolean }> {
  if (isLocalBypass(request, env)) {
    return {
      email: (env.ALLOWED_EMAIL || "developer@example.invalid").toLowerCase(),
      local: true,
    };
  }

  const teamValue = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  const allowedEmail = env.ALLOWED_EMAIL?.toLowerCase();
  if (!teamValue || !audience || !allowedEmail) {
    throw new AccessDeniedError("Cloudflare Access 尚未完成配置。", 503);
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AccessDeniedError("缺少 Cloudflare Access 身份凭据。", 401);

  const teamDomain = normalizedTeamDomain(teamValue);
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience,
    });
    const email = getEmail(payload);
    if (!email || email !== allowedEmail) {
      throw new AccessDeniedError("当前邮箱无权访问此服务。", 403);
    }
    return { email, local: false };
  } catch (error) {
    if (error instanceof AccessDeniedError) throw error;
    throw new AccessDeniedError("Cloudflare Access 会话无效或已过期。", 401);
  }
}

export function assertSameOriginMutation(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const requestedWith = request.headers.get("x-requested-with");
  if (origin !== expectedOrigin || requestedWith !== "ncm-archive") {
    throw new AccessDeniedError("请求来源校验失败。", 403);
  }
}
