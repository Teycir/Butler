import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { materializeProject, invalidateProjectCache } from '../../../events/materializer.js';
import { appendEvent } from '../../../events/store.js';
import { getDb } from '../../../db/database.js';
import { validateSession, getActiveSessions } from '../../../coordinator/lifecycle.js';
import { now as getCurrentTimestamp, PEER_LIVENESS_TTL_SECONDS, PEER_ACTIVE_LOCK_SECONDS } from '../../../constants.js';

export async function handleSyncContext(
  args: Record<string, any>,
  projectId: string
): Promise<{ content: Array<{ type: string; text: string }> }> {
  validateSession(projectId, String(args.session_id));
  const confirmSync = !!args.confirm_sync;
  const now = getCurrentTimestamp();
  const db = getDb();
  const state = materializeProject(projectId, false);

  // Calculate active claim counts for each session to determine prominence
  const claimCounts = new Map<string, number>();
  for (const todo of Object.values(state.todos)) {
    if (todo.claimed_by) {
      claimCounts.set(todo.claimed_by, (claimCounts.get(todo.claimed_by) || 0) + 1);
    }
  }

  // 1. Get active peer sessions (excluding our own session, active, and within the liveness TTL)
  // Enforces status 'alive' and a heartbeat freshness TTL check
  const peers = getActiveSessions(projectId)
    .filter(s => s.id !== String(args.session_id) && s.status === 'alive' && (now - s.last_heartbeat) <= PEER_LIVENESS_TTL_SECONDS)
    .map(s => {
      const claimsCount = claimCounts.get(s.id) || 0;
      // Score formula: (claims * 10000) + freshness
      const heartbeatAge = Math.max(0, now - s.last_heartbeat);
      const freshness = Math.max(0, PEER_LIVENESS_TTL_SECONDS - heartbeatAge);
      const score = (claimsCount * 10000) + freshness;
      return { session: s, claimsCount, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(p => p.session);

  if (peers.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No other active AI sessions detected for project "${projectId}". Your workspace is currently standalone.`
      }]
    };
  }

  const mainPeer = peers[0];

  // 2. Format peer summaries for prompt check
  const peerClaimsMap = new Map<string, string[]>();
  for (const todo of Object.values(state.todos)) {
    if (todo.claimed_by && todo.claimed_by !== String(args.session_id)) {
      const list = peerClaimsMap.get(todo.claimed_by) || [];
      list.push(`[#${todo.id}] "${todo.title}"`);
      peerClaimsMap.set(todo.claimed_by, list);
    }
  }

  const peerSummaries = peers.map(p => {
    const claims = peerClaimsMap.get(p.id) || [];
    const claimsText = claims.length > 0
      ? `actively working on:\n      - ${claims.join('\n      - ')}`
      : `no active claims.`;
    return `• Session "${p.id}" (${p.client_type}) - ${claimsText}`;
  }).join('\n\n');

  if (!confirmSync) {
    // Return status check prompt
    const promptText = 
      `Detected active peer AI session(s) in this project:\n\n` +
      `${peerSummaries}\n\n` +
      `Would you like to synchronize your context with the most active peer "${mainPeer.id}"? ` +
      `Calling synccontext with confirm_sync: true will:\n` +
      `  1. Transfer all claimed tasks from "${mainPeer.id}" to your session.\n` +
      `  2. Synchronize your event log timeline marker to match their seen history.\n` +
      `  3. Import their recent memories, architectural decisions, and active rules.`;
      
    return {
      content: [{
        type: 'text',
        text: promptText
      }]
    };
  } else {
    const result = db.transaction(() => {
      // Invalidate cache first to read the freshest state from DB
      invalidateProjectCache(projectId);
      const freshState = materializeProject(projectId, false);

      // Verify that the mainPeer exists and is still valid
      const peerSessionRow = db.prepare('SELECT last_event_seen, last_heartbeat FROM sessions WHERE id = ? AND project_id = ?')
        .get(mainPeer.id, projectId) as { last_event_seen: number; last_heartbeat: number } | undefined;
      
      if (!peerSessionRow) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Cannot synchronize context: Peer session "${mainPeer.id}" no longer exists.`
        );
      }

      // Refuse claim transfer if the peer is actively working (heartbeat under PEER_ACTIVE_LOCK_SECONDS seconds ago)
      const isPeerActive = (now - peerSessionRow.last_heartbeat) < PEER_ACTIVE_LOCK_SECONDS;
      if (isPeerActive) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Cannot synchronize context: Peer session "${mainPeer.id}" is actively working right now (heartbeat detected under ${PEER_ACTIVE_LOCK_SECONDS} seconds ago).`
        );
      }

      // 3. REAL SYNC Action A: Transfer all claims from mainPeer to calling session
      const transferredClaims: string[] = [];
      for (const todo of Object.values(freshState.todos)) {
        if (todo.claimed_by === mainPeer.id && todo.status === 'pending') {
          transferredClaims.push(`[#${todo.id}] "${todo.title}"`);
          
          // Append a TODO_UNCLAIMED event for the peer to release ownership cleanly
          appendEvent(projectId, mainPeer.id, 'TODO_UNCLAIMED', {
            todo_id: todo.id,
            session_id: mainPeer.id
          });

          // Append a TODO_CLAIMED event to transfer ownership in the event log
          appendEvent(projectId, String(args.session_id), 'TODO_CLAIMED', {
            todo_id: todo.id,
            session_id: String(args.session_id),
            claimed_at: now
          });
        }
      }

      // 4. REAL SYNC Action B: Align seen event timeline to the peer's last seen event
      const targetEventId = peerSessionRow.last_event_seen;
      db.prepare('UPDATE sessions SET last_event_seen = ? WHERE id = ?')
        .run(targetEventId, String(args.session_id));

      // 5. REAL SYNC Action C: Fetch memories, decisions, and rules associated with the peer session
      
      // Fetch memories specifically associated with the peer session
      const peerMemories = db.prepare(`
        SELECT type, content, importance FROM memories
        WHERE project_id = ? AND session_id = ?
        ORDER BY created_at DESC LIMIT 5
      `).all(projectId, mainPeer.id) as Array<{ type: string; content: string; importance: number }>;

      const memoriesList = peerMemories.map(m => `- [${m.type.toUpperCase()}] ${m.content} (importance: ${m.importance})`).join('\n');

      // Fetch rules created by the peer session
      const peerRules = Object.values(freshState.rules)
        .filter(r => r.created_by === mainPeer.id)
        .map(r => `- ${r.content} (ID: ${r.id})`)
        .join('\n');

      // Fetch decisions updated/created by the peer session
      const peerDecisions = Object.values(freshState.decisions)
        .filter(d => d.updated_by === mainPeer.id)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 5)
        .map(d => `- [${d.id}] "${d.title}": ${d.decision}`)
        .join('\n');

      // Append alignment broadcast so other sessions are aware
      const broadcastEvent = appendEvent(projectId, String(args.session_id), 'BROADCAST', {
        from_session_id: String(args.session_id),
        content: `🔄 Session "${args.session_id}" synchronized context with active peer "${mainPeer.id}".`,
        sent_at: now
      });

      // Set the calling session's last_event_seen to the broadcast event we just created
      // so that the caller's timeline is fully updated and has no pending unseen self-generated events.
      db.prepare('UPDATE sessions SET last_event_seen = ? WHERE id = ?')
        .run(broadcastEvent.id, String(args.session_id));

      return {
        transferredClaims,
        targetEventId,
        broadcastEventId: broadcastEvent.id,
        memoriesList,
        peerRules,
        peerDecisions
      };
    })();

    // Invalidate project cache to materialize changes
    invalidateProjectCache(projectId);

    const rulesSection = result.peerRules.length > 0 ? `\n\nImported Peer Rules:\n${result.peerRules}` : '';
    const decisionsSection = result.peerDecisions.length > 0 ? `\n\nImported Peer Architectural Decisions:\n${result.peerDecisions}` : '';
    const memoriesSection = result.memoriesList.length > 0 ? `\n\nImported Peer Memories:\n${result.memoriesList}` : '';
    const claimsSection = result.transferredClaims.length > 0
      ? `\n\nYou have taken over their claimed tasks:\n- ${result.transferredClaims.join('\n- ')}`
      : '\n\nNo claimed tasks were active for this peer.';

    const promptText = 
      `Successfully synchronized context with active session "${mainPeer.id}" (${mainPeer.client_type}).\n` +
      `Your timeline is aligned to event ID ${result.broadcastEventId} (synchronized peer timeline up to event ${result.targetEventId}).\n` +
      `${claimsSection}${rulesSection}${decisionsSection}${memoriesSection}\n\n` +
      `Please update your active prompt state to reflect these synchronized project constraints and tasks.`;

    return {
      content: [{
        type: 'text',
        text: promptText
      }]
    };
  }
}
