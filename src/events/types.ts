export type EventType =
  // Session Events
  | 'SESSION_CONNECTED'
  | 'SESSION_DISCONNECTED'
  | 'SESSION_STALE'
  | 'SESSION_RECOVERED'
  // Task Events
  | 'TODO_CREATED'
  | 'TODO_UPDATED'
  | 'TODO_COMPLETED'
  | 'TODO_DELETED'
  | 'TODO_CLAIMED'
  | 'TODO_UNCLAIMED'
  | 'TODO_CONFLICT'
  // Knowledge Events
  | 'WIKI_UPDATED'
  | 'RULE_ADDED'
  | 'RULE_REMOVED'
  | 'DECISION_RECORDED'
  | 'HANDOFF_CREATED'
  // Coordination Events (Phase 3)
  | 'MESSAGE_SENT'
  | 'BROADCAST'
  // Memory Events
  | 'SUMMARY_CREATED'
  | 'MEMORY_EXTRACTED'
  | 'MEMORY_DELETED'
  | 'SNAPSHOT_CREATED';

// Memory type constants - single source of truth
export const MEMORY_TYPES = ['summary', 'decision', 'rule', 'wiki'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

export interface EventRecord {
  id: number;
  project_id: string;
  session_id: string;
  type: EventType;
  payload: string; // JSON stringified
  created_at: number;
}

// Payload schemas for specific events
export interface TodoPayload {
  todo_id: number;
  title: string;
  status: 'pending' | 'completed';
  priority?: 'low' | 'medium' | 'high';
  version: number;
  updated_at?: number;
}

export interface WikiPayload {
  topic: string;
  content: string;
  version: number;
}

export interface RulePayload {
  rule_id: string;
  content: string;
  version: number;
}

export interface DecisionPayload {
  decision_id: string;
  title: string;
  context: string;
  decision: string;
  version: number;
}

export interface HandoffPayload {
  session_id: string;
  completed_todos: string[];
  pending_todos: string[];
  recent_decisions: string[];
  rules_added?: string[];
  wiki_updated?: string[];
  summary: string;
  timestamp: number;
}

export interface SessionPayload {
  session_id: string;
  client_type: string;
  timestamp: number;
}

// Map EventType to its respective strongly typed payload
export interface EventPayloadMap {
  'SESSION_CONNECTED': SessionPayload;
  'SESSION_DISCONNECTED': { session_id: string; timestamp: number; handoff?: any; reason?: string };
  'SESSION_STALE': { session_id: string; timestamp: number };
  'SESSION_RECOVERED': SessionPayload;
  'TODO_CREATED': { todo_id: number; title: string; priority: 'low' | 'medium' | 'high' };
  'TODO_UPDATED': { todo_id: number; title?: string; priority?: 'low' | 'medium' | 'high'; status?: 'pending' | 'completed' };
  'TODO_COMPLETED': { todo_id: number; version: number };
  'TODO_DELETED': { todo_id: number };
  'TODO_CLAIMED': { todo_id: number; session_id: string; claimed_at: number };
  'TODO_UNCLAIMED': { todo_id: number; session_id: string };
  'TODO_CONFLICT': { todo_id: number; conflicting_session_id: string; conflict_type: 'concurrent_complete' | 'concurrent_update' };
  'WIKI_UPDATED': { topic: string; content: string };
  'RULE_ADDED': { rule_id: string; content: string };
  'RULE_REMOVED': { rule_id: string };
  'DECISION_RECORDED': { decision_id: string; title: string; context: string; decision: string };
  'HANDOFF_CREATED': HandoffPayload;
  'MESSAGE_SENT': { from_session_id: string; to_session_id: string; content: string; sent_at: number };
  'BROADCAST': { from_session_id: string; content: string; sent_at: number };
  'SUMMARY_CREATED': { summary: string; context: string };
  'MEMORY_EXTRACTED': { memory_id: number; type: string; content: string };
  'MEMORY_DELETED': { memory_id: number };
  'SNAPSHOT_CREATED': { snapshot_id: number; schema_version: number };
}

