// Session lifecycle thresholds (in seconds)
export const SESSION_STALE_THRESHOLD_SECS = 60;
export const SESSION_DEAD_THRESHOLD_SECS = 300;

// Event store and snapshot configuration
export const SNAPSHOT_EVENT_INTERVAL = 100;
export const SNAPSHOT_CHECK_INTERVAL_SECS = 1800; // 30 minutes
export const SNAPSHOT_RETENTION_COUNT = 3;

/**
 * Incremented whenever the shape of ProjectState changes in a way that makes
 * old snapshots structurally incompatible with the current materializer.
 * On mismatch the snapshot is skipped and Butler replays from scratch or from
 * the prior clean snapshot.
 *
 * History:
 *   1 — initial schema (todos, wiki, rules, decisions, handoffs, lastEventId)
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

// Memory and search limits
export const MEMORY_SEARCH_LIMIT = 500;
export const HANDOFF_HISTORY_LIMIT = 50;

// Input validation limits
export const MAX_INPUT_LENGTH = 10000;
export const MAX_TITLE_LENGTH = 500;

// Sentinel session ID used for system-generated audit events that have no real session context
export const SYSTEM_SESSION_ID = 'system';

// Timestamp utilities
export const now = () => Math.floor(Date.now() / 1000);
export const toDate = (unixSecs: number) => new Date(unixSecs * 1000);
