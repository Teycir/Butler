/**
 * cli/tuiRenderer.ts
 *
 * Premium visual renderer for the Butler TUI.
 * Formats database status and event logs into a highly polished, 256-color terminal UI.
 */

import path from 'path';
import { formatAge, truncate } from '../lib/format.js';
import { computeHandoffQualityScore } from '../coordinator/lifecycle.js';
import {
  c,
  stripAnsi,
  padRight,
  type ProjectRow,
  type SessionRow,
  type EventRow,
  type ProjectState
} from './tuiTheme.js';

const WIDTH = 100;
const LEFT_W = 46;
const RIGHT_W = 47;

export function generateDashboardString(
  dbPath: string,
  project: ProjectRow,
  sessions: SessionRow[],
  state: ProjectState,
  eventCount: number,
  lastEvent: EventRow | null,
  recentHandoffs: EventRow[],
  nowTs: number,
  dbSizeKb: number,
  projectCount: number,
  schemaVersion: number,
  projectIndexInfo?: string
): string {
  const active = sessions.filter(s => s.status !== 'dead');
  const liveCount = active.filter(s => s.status === 'alive').length;
  const staleCount = active.filter(s => s.status === 'stale').length;

  const todos = Object.values(state.todos ?? {});
  const pending = todos.filter(t => t.status === 'pending');
  const completedCount = todos.filter(t => t.status === 'completed').length;
  const totalCount = todos.length;

  const lines: string[] = [];

  // Alternating heartbeat pulse animation
  const pulseDot = (Math.floor(Date.now() / 1000) % 2 === 0)
    ? `${c.green}●${c.reset}`
    : `${c.dim}${c.green}○${c.reset}`;

  // 1. Header block (Premium title banner)
  const statusLabel = liveCount > 0
    ? `${c.green}🟢 HEALTHY${c.reset}`
    : staleCount > 0
      ? `${c.yellow}🟡 STALE${c.reset}`
      : `${c.red}🔴 INACTIVE${c.reset}`;

  lines.push(`${c.border}┌${'─'.repeat(WIDTH - 2)}┐${c.reset}`);
  
  const headerLeft = ` ${c.bold}${c.primary}🤵 BUTLER ORCHESTRATOR${c.reset} ${c.dim}│${c.reset} Project: ${c.white}${project.id}${c.reset}${projectIndexInfo ? ` ${c.gray}(${projectIndexInfo})${c.reset}` : ''}`;
  const headerRight = `${pulseDot} ${c.gray}${new Date().toLocaleTimeString()}${c.reset} `;
  
  // Calculate visible length of the right clock fragment to avoid border wrapping
  const visibleRightLen = stripAnsi(headerRight).length;
  lines.push(`${c.border}│${c.reset}${padRight(headerLeft, WIDTH - 2 - visibleRightLen)}${headerRight}${c.border}│${c.reset}`);

  // Display abbreviated path like "workspace/butler.db" instead of aggressive truncation (cross-platform)
  const dbShortPath = `${path.basename(path.dirname(dbPath))}/${path.basename(dbPath)}`;

  const dbLabel = `DB: ${c.white}${dbShortPath}${c.reset} (${dbSizeKb} KB)`;
  const metaLabel = `Schema: ${c.white}v${schemaVersion}${c.reset} │ Projects: ${c.white}${projectCount}${c.reset} │ Status: ${statusLabel}`;
  lines.push(`${c.border}│${c.reset} ${padRight(dbLabel, LEFT_W)} ${c.dim}│${c.reset} ${padRight(metaLabel, RIGHT_W)} ${c.border}│${c.reset}`);
  
  lines.push(`${c.border}├${'─'.repeat(LEFT_W + 2)}┬${'─'.repeat(RIGHT_W + 2)}┤${c.reset}`);

  // 2. Body Columns
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // ── Left: Sessions ──
  leftLines.push(`${c.bold}${c.secondary}👤 Topology Sessions (${active.length})${c.reset}`);
  if (active.length === 0) {
    leftLines.push(`  ${c.dim}No active client sessions${c.reset}`);
  } else {
    for (const s of active.slice(0, 5)) {
      const age = formatAge(nowTs - s.last_heartbeat);
      const isAlive = s.status === 'alive';
      const statusIcon = isAlive ? `${c.green}●${c.reset}` : `${c.yellow}○${c.reset}`;
      const name = truncate(s.id, 14);
      const client = s.client_type.slice(0, 12);
      leftLines.push(`  ${statusIcon} ${c.white}${name.padEnd(14)}${c.reset} ${c.gray}${client.padEnd(12)}${c.reset} ${c.dim}${age}${c.reset}`);
    }
  }
  leftLines.push('');

  // ── Left: Broadcast Messages ──
  const broadcasts = state.broadcasts ?? [];
  leftLines.push(`${c.bold}${c.magenta}📢 Broadcast Stream (${broadcasts.length})${c.reset}`);
  if (broadcasts.length === 0) {
    leftLines.push(`  ${c.dim}No broadcast announcements${c.reset}`);
  } else {
    for (const b of broadcasts.slice(-4).reverse()) {
      const age = formatAge(nowTs - b.sent_at);
      leftLines.push(`  ${c.dim}${age}${c.reset} [${c.white}${truncate(b.from_session_id, 8)}${c.reset}]: ${c.cyan}${truncate(b.content, 22)}${c.reset}`);
    }
  }

  // ── Right: Task Progress Bar ──
  rightLines.push(`${c.bold}${c.yellow}🎯 Shared Task Space (${pending.length} open)${c.reset}`);
  
  if (totalCount > 0) {
    const percent = Math.round((completedCount / totalCount) * 100);
    const barWidth = 16;
    const filled = Math.round((completedCount / totalCount) * barWidth);
    const barStr = `${c.green}${'█'.repeat(filled)}${c.reset}${c.darkGray}${'░'.repeat(barWidth - filled)}${c.reset}`;
    rightLines.push(`  Progress: [${barStr}] ${c.white}${percent}%${c.reset} (${completedCount}/${totalCount} done)`);
  } else {
    rightLines.push(`  ${c.dim}No tasks registered${c.reset}`);
  }

  // ── Right: TODOs List ──
  if (pending.length === 0) {
    rightLines.push(`  ${c.dim}No pending tasks${c.reset}`);
  } else {
    const sortedTodos = [...pending].sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.priority as keyof typeof order] ?? 1) - (order[b.priority as keyof typeof order] ?? 1);
    });
    for (const t of sortedTodos.slice(0, 4)) {
      const isHigh = t.priority === 'high';
      const isMed = t.priority === 'medium';
      const pColor = isHigh ? c.red : isMed ? c.yellow : c.green;
      const pLabel = t.priority.slice(0, 3).toUpperCase();
      
      const claim = t.claimed_by 
        ? `${c.secondary}🔒 ${truncate(t.claimed_by, 8)}${c.reset}` 
        : `${c.dim}unclaimed${c.reset}`;
      rightLines.push(`  ${pColor}■ ${pLabel}${c.reset} [#${t.id}] ${c.white}${truncate(t.title, 18).padEnd(18)}${c.reset} │ ${claim}`);
    }
    if (pending.length > 4) {
      rightLines.push(`  ${c.dim}... and ${pending.length - 4} more tasks${c.reset}`);
    }
  }
  rightLines.push('');

  // ── Right: Optimistic Conflicts ──
  const conflicts = state.conflicts ?? [];
  rightLines.push(`${c.bold}${c.red}⚡ Mutation Conflicts (${conflicts.length})${c.reset}`);
  if (conflicts.length === 0) {
    rightLines.push(`  ${c.dim}No concurrency issues detected${c.reset}`);
  } else {
    for (const conf of conflicts.slice(-3).reverse()) {
      const age = formatAge(nowTs - conf.detected_at);
      const shortType = conf.conflict_type.replace('concurrent_', '');
      rightLines.push(`  ${c.red}⚠️  Task #${conf.todo_id}${c.reset} │ ${c.yellow}${shortType}${c.reset} │ ${c.dim}${age}${c.reset}`);
    }
  }

  // Draw columns side by side
  const bodyLen = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyLen; i++) {
    const left = padRight(leftLines[i] ?? '', LEFT_W);
    const right = padRight(rightLines[i] ?? '', RIGHT_W);
    lines.push(`${c.border}│${c.reset} ${left} ${c.border}│${c.reset} ${right} ${c.border}│${c.reset}`);
  }

  // 3. Bottom partition
  lines.push(`${c.border}├${'─'.repeat(WIDTH - 2)}┤${c.reset}`);

  // ── Bottom: Recent Handoffs ──
  const handoffsHeader = `${c.bold}${c.white}🤝 RECENT WORKSPACE HANDOFFS${c.reset}`;
  lines.push(`${c.border}│${c.reset} ${padRight(handoffsHeader, WIDTH - 4)} ${c.border}│${c.reset}`);
  
  if (recentHandoffs.length === 0) {
    const noHandoffsMsg = `${c.dim}No recent agent handoffs recorded${c.reset}`;
    lines.push(`${c.border}│${c.reset}   ${padRight(noHandoffsMsg, WIDTH - 6)} ${c.border}│${c.reset}`);
  } else {
    for (const h of recentHandoffs) {
      let p: any = {};
      try { p = JSON.parse(h.payload); } catch {}
      const hand = h.type === 'HANDOFF_CREATED' ? p : p.handoff;
      const age = formatAge(nowTs - h.created_at);
      const summary = truncate(hand?.summary || '(no summary)', 62);
      const isAgent = h.type === 'HANDOFF_CREATED';
      const actorLabel = isAgent ? `${c.primary}agent${c.reset}` : `${c.yellow}system${c.reset}`;
      
      const rowText = `  [${actorLabel}] ${c.white}${truncate(h.session_id, 12)}${c.reset} (${c.dim}${age}${c.reset}) - ${c.italic}"${summary}"${c.reset}`;
      lines.push(`${c.border}│${c.reset} ${padRight(rowText, WIDTH - 4)} ${c.border}│${c.reset}`);
    }
  }

  // ── Bottom: Quality Coaching Metrics ──
  if (recentHandoffs.length > 0) {
    let p: any = {};
    try { p = JSON.parse(recentHandoffs[0].payload); } catch {}
    const hand = recentHandoffs[0].type === 'HANDOFF_CREATED' ? p : p.handoff;
    const summary = hand?.summary || '';
    if (summary) {
      const score = computeHandoffQualityScore(summary);
      const percent = Math.round(score * 100);
      const barLen = 10;
      const filled = Math.round(score * barLen);
      const scoreColor = score >= 0.7 ? c.green : score >= 0.45 ? c.yellow : c.red;
      const bar = `${scoreColor}${'█'.repeat(filled)}${c.reset}${c.darkGray}${'░'.repeat(barLen - filled)}${c.reset}`;
      
      const wordCount = summary.trim().split(/\s+/).length;
      const hasStructure = /[\n\-*•]/.test(summary);
      const hasKeywords = /\b(completed|pending|blocked|decided|fixed|added|removed|updated|todo|issue|note)\b/i.test(summary);
      
      const metricsText = `Words: ${wordCount >= 20 ? c.green : c.yellow}${wordCount}${c.reset} │ Struct: ${hasStructure ? c.green : c.red}${hasStructure ? '✓' : '✗'}${c.reset} │ Verbs: ${hasKeywords ? c.green : c.red}${hasKeywords ? '✓' : '✗'}${c.reset}`;
      
      const scoreRow = `  Quality Rating: [${bar}] ${scoreColor}${percent}%${c.reset} (latest: ${c.white}${recentHandoffs[0].session_id}${c.reset}) │ ${metricsText}`;
      lines.push(`${c.border}│${c.reset} ${padRight(scoreRow, WIDTH - 4)} ${c.border}│${c.reset}`);
    }
  }

  // 4. Footer & Database Telemetry
  lines.push(`${c.border}├${'─'.repeat(WIDTH - 2)}┤${c.reset}`);
  
  const lastEvName = lastEvent ? `${lastEvent.type} (${formatAge(nowTs - lastEvent.created_at)})` : 'none';
  const footerTelemetry = ` Events: ${c.white}${eventCount}${c.reset} │ Last Event: ${c.white}${lastEvName}${c.reset}`;
  const shortcuts = `[Q] Quit │ [R] Refresh │ [←/→] Project │ Auto-Refresh: 2s `;
  // Pad the telemetry space dynamically to fill the width (WIDTH - 2 for borders, minus shortcuts length)
  const telemetryPad = WIDTH - 2 - stripAnsi(shortcuts).length;
  lines.push(`${c.border}│${c.reset}${padRight(footerTelemetry, telemetryPad)}${c.dim}${shortcuts}${c.reset}${c.border}│${c.reset}`);
  lines.push(`${c.border}└${'─'.repeat(WIDTH - 2)}┘${c.reset}`);

  return lines.join('\n');
}
