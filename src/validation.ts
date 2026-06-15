import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MAX_INPUT_LENGTH, MAX_TITLE_LENGTH, SYSTEM_SESSION_ID } from './constants.js';

export function validateProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'invalid_project_id',
        message: 'Invalid project_id format. Only alphanumeric characters, underscores, and hyphens are allowed.',
        hint: 'Use a simple project identifier like my-project or project123.',
        docs: 'https://github.com/Teycir/Butler#project-management'
      })
    );
  }
}

export function validateSessionId(sessionId: string): void {
  if (sessionId === SYSTEM_SESSION_ID) {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'reserved_session_id',
        message: `Invalid session_id. The identifier '${SYSTEM_SESSION_ID}' is reserved for system events.`,
        hint: 'Use a different session_id for your client.',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'invalid_session_id',
        message: 'Invalid session_id format. Only alphanumeric characters, underscores, and hyphens are allowed.',
        hint: 'Use session naming convention: {client}-{role}-{number} (e.g. cursor-main-1).',
        docs: 'https://github.com/Teycir/Butler#session-management'
      })
    );
  }
}

export function sanitizeInput(str: string, maxLength: number = MAX_INPUT_LENGTH): string {
  if (str.length > maxLength) {
    throw new McpError(
      ErrorCode.InvalidParams,
      JSON.stringify({
        error: 'input_too_long',
        message: `Input exceeds maximum length of ${maxLength} characters`,
        hint: `Truncate or split your content to be under ${maxLength} characters.`,
        docs: 'https://github.com/Teycir/Butler#input-limits'
      })
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
export function escapeMarkdownForRender(str: string): string {
  return str.replace(/([#`*_[\]>\\|])/g, '\\$1');
}
