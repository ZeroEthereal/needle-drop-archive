/** Preserve source wording and order while removing empty or repeated entries. */
export function normalizeSongTextList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))]
    : [];
}

export function validSongDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function songSubtitle(song: { aliases?: string[] | null; translations?: string[] | null }): string {
  const aliases = normalizeSongTextList(song.aliases);
  return (aliases.length ? aliases : normalizeSongTextList(song.translations)).join(" / ");
}

export function formatSongDuration(durationMs?: number | null): string {
  const duration = validSongDuration(durationMs);
  if (duration === null) return "—";
  const seconds = Math.floor(duration / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
