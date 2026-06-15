/**
 * cli/tuiTheme.ts
 *
 * Theme configuration, types, and terminal formatting helpers for the Butler TUI.
 */

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
}

export interface SessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly client_type: string;
  readonly status: string;
  readonly created_at: number;
  readonly last_heartbeat: number;
}

export interface EventRow {
  readonly id: number;
  readonly project_id: string;
  readonly session_id: string;
  readonly type: string;
  readonly payload: string;
  readonly created_at: number;
}

export interface SnapshotRow {
  readonly event_id: number;
  readonly snapshot_json: string;
  readonly sha256_hex: string;
  readonly created_at: number;
}

export interface TodoItem {
  readonly id: number;
  readonly title: string;
  readonly priority: string;
  readonly status: string;
  readonly claimed_by?: string;
}

export interface ProjectState {
  readonly todos?: Record<number, TodoItem>;
  readonly messages?: Array<{
    readonly from_session_id: string;
    readonly to_session_id: string;
    readonly content: string;
    readonly sent_at: number;
  }>;
  readonly broadcasts?: Array<{
    readonly from_session_id: string;
    readonly content: string;
    readonly sent_at: number;
  }>;
  readonly conflicts?: Array<{
    readonly todo_id: number;
    readonly conflict_type: string;
    readonly detected_at: number;
  }>;
}

// ─── Color Palette (Premium 256 Colors) ──────────────────────────────────────

export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  
  accent: '\x1b[38;5;99m',      // Electric indigo
  primary: '\x1b[38;5;141m',    // Soft lavender
  secondary: '\x1b[38;5;75m',   // Ice blue
  green: '\x1b[38;5;78m',       // Mint green
  yellow: '\x1b[38;5;221m',     // Warm amber
  red: '\x1b[38;5;203m',        // Coral red
  magenta: '\x1b[38;5;213m',    // Rose pink
  cyan: '\x1b[38;5;86m',        // Pale teal
  white: '\x1b[38;5;255m',      // Off-white
  gray: '\x1b[38;5;244m',       // Slate gray
  darkGray: '\x1b[38;5;239m',   // Dark border gray
  border: '\x1b[38;5;241m',     // Border line gray
  
  cls: '\x1b[2J\x1b[0;0H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h'
} as const;

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function padRight(str: string, length: number): string {
  const clean = stripAnsi(str);
  const diff = length - clean.length;
  return str + (diff > 0 ? ' '.repeat(diff) : '');
}
