/**
 * lib/format.ts
 * Pure, zero-dependency formatting utilities.
 * No Butler-specific imports — safe to copy into any project.
 */

/**
 * Returns a human-readable age string for a duration given in seconds.
 *   0–59s  → "Xs ago"
 *   1–59m  → "Xm ago"
 *   1h+    → "Xh ago"
 *   null   → fallback string
 */
export function formatAge(seconds: number | null, fallback = 'unknown'): string {
  if (seconds == null) return fallback;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * Returns a short ISO-like timestamp label from a Unix epoch (seconds).
 */
export function formatTimestamp(unixSecs: number): string {
  return new Date(unixSecs * 1000).toISOString();
}

/**
 * Returns "today" / "1 day ago" / "N days ago" for display in memory recency labels.
 */
export function formatRecencyDays(createdAtUnixSecs: number): string {
  const days = Math.floor((Date.now() / 1000 - createdAtUnixSecs) / 86400);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/**
 * Truncates a string to maxLen, appending "…" if needed.
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}
