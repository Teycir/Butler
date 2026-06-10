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
 * Bump policy: increment when ProjectState fields are added, removed, or
 * renamed in a way that makes old snapshots structurally incompatible.
 * Old snapshots whose schema_version doesn't match are silently skipped
 * in getLatestSnapshot() — Butler falls back to full event replay from the
 * prior clean snapshot, or from the beginning if none exists.
 * There is no automatic migration of snapshot data; the event log is always
 * the source of truth.
 *
 * History:
 *   1 — initial schema (todos, wiki, rules, decisions, handoffs, lastEventId)
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

// Memory and search limits
export const MEMORY_SEARCH_LIMIT = 500;
export const HANDOFF_HISTORY_LIMIT = 50;

// ProjectState history caps — prevent unbounded in-memory growth
export const CONFLICT_HISTORY_LIMIT = 20;
export const MESSAGE_HISTORY_LIMIT = 50;
export const BROADCAST_HISTORY_LIMIT = 20;

// Coordination thresholds
export const CONFLICT_WINDOW_SECS = 10; // concurrent write window for conflict detection

// Resource scoring thresholds
export const MEMORY_RELEVANCE_THRESHOLD = 0.3; // minimum score to surface a memory in /context

// Input validation limits
export const MAX_INPUT_LENGTH = 10000;
export const MAX_TITLE_LENGTH = 500;

// Sentinel session ID used for system-generated audit events that have no real session context
export const SYSTEM_SESSION_ID = 'system';

// Timestamp utilities
export const now = () => Math.floor(Date.now() / 1000);
export const toDate = (unixSecs: number) => new Date(unixSecs * 1000);
