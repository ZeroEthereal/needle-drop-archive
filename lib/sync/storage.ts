import type { D1DatabasePort } from "./db";

export async function getSetting<T>(
  db: D1DatabasePort,
  key: string,
): Promise<T | null> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function putSetting(
  db: D1DatabasePort,
  key: string,
  value: unknown,
): Promise<void> {
  const result = await db
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .bind(key, JSON.stringify(value))
    .run();
  if (!result.success) throw new Error(result.error ?? "Could not save setting");
}
