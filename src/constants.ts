// Session lifecycle thresholds (in seconds)
export const SESSION_STALE_THRESHOLD_SECS = 60;
export const SESSION_DEAD_THRESHOLD_SECS = 300;

// Event store and snapshot configuration
export const SNAPSHOT_EVENT_INTERVAL = 100;
export const SNAPSHOT_CHECK_INTERVAL_SECS = 1800; // 30 minutes
export const SNAPSHOT_RETENTION_COUNT = 3;

// Memory and search limits
export const MEMORY_SEARCH_LIMIT = 500;
export const HANDOFF_HISTORY_LIMIT = 50;

// Input validation limits
export const MAX_INPUT_LENGTH = 10000;
export const MAX_TITLE_LENGTH = 500;

// Timestamp utilities
export const now = () => Math.floor(Date.now() / 1000);
export const toDate = (unixSecs: number) => new Date(unixSecs * 1000);
