import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MAX_INPUT_LENGTH, MAX_TITLE_LENGTH, SYSTEM_SESSION_ID } from './constants.js';

export function validateProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid project_id format. Only alphanumeric characters, underscores, and hyphens are allowed.'
    );
  }
}

export function validateSessionId(sessionId: string): void {
  if (sessionId === SYSTEM_SESSION_ID) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid session_id. The identifier '${SYSTEM_SESSION_ID}' is reserved for system events.`
    );
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid session_id format. Only alphanumeric characters, underscores, and hyphens are allowed.'
    );
  }
}

export function sanitizeInput(str: string, maxLength: number = MAX_INPUT_LENGTH): string {
  if (str.length > maxLength) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Input exceeds maximum length of ${maxLength} characters`
    );
  }
  // Remove control characters except newlines and tabs
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function sanitizeTitle(title: string): string {
  return sanitizeInput(title, MAX_TITLE_LENGTH);
}

/**
 * Escapes markdown control characters in user-supplied strings before embedding
 * them in a markdown template. Prevents prompt injection via crafted content.
 *
 * Applies to: handoff summaries, wiki content/topics, rule content,
 * decision titles/context/decision fields.
 *
 * Does NOT apply to the raw JSON resource — only to the markdown render path.
 *
 * Characters escaped: # ` * _ [ ] > \ |
 * Newlines are preserved (they are structural in markdown blockquotes).
 */
export function sanitizeMarkdown(str: string): string {
  return str.replace(/([#`*_[\]>\\|])/g, '\\$1');
}
