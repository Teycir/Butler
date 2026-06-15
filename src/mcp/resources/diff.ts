import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getProjectDiff } from '../../coordinator/lifecycle.js';

export function buildDiffResource(uri: string, projectId: string, queryParams: Record<string, string>) {
  const sinceEventId = queryParams.since ? parseInt(queryParams.since, 10) : 0;
  if (isNaN(sinceEventId) || sinceEventId < 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid 'since' parameter — must be a non-negative integer event ID`
    );
  }

  const diffEntries = getProjectDiff(projectId, sinceEventId);
  const grouped: Record<string, typeof diffEntries> = {};
  for (const entry of diffEntries) {
    const key = entry.type.split('_')[0];
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }

  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        project_id: projectId,
        since_event_id: sinceEventId,
        total_changes: diffEntries.length,
        grouped,
        entries: diffEntries
      }, null, 2)
    }]
  };
}
