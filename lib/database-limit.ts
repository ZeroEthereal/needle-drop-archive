export const DATABASE_DAILY_LIMIT_CODE = "DATABASE_DAILY_LIMIT_EXCEEDED";

/** Match D1's daily quota message, not its generic 7500 error code. */
export function isDatabaseDailyLimit(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 24) {
    const value = pending.shift();
    if (seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string") {
      if (/exceeded\s+D1['’]s free tier daily row (?:read|write) limit\b/i.test(value)) return true;
    } else if (value && typeof value === "object") {
      const detail = value as { message?: unknown; cause?: unknown; errors?: unknown };
      pending.push(detail.message, detail.cause);
      if (Array.isArray(detail.errors)) pending.push(...detail.errors);
    }
  }
  return false;
}

export function databaseDailyLimit(now = new Date()) {
  // D1's daily allowance resets at 00:00 UTC, which is 08:00 in Beijing.
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "long", day: "numeric",
  }).format(reset);
  return {
    code: DATABASE_DAILY_LIMIT_CODE,
    message: `本站数据库今日免费读写额度已用完，暂时无法读取或保存数据。请于${date}08:00（北京时间）额度重置后再试。`,
    retryAt: reset.toISOString(),
    retryAfter: Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000)),
  };
}
