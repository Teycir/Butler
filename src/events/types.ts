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
  // Knowledge Events
  | 'WIKI_UPDATED'
  | 'RULE_ADDED'
  | 'RULE_REMOVED'
  | 'DECISION_RECORDED'
  | 'HANDOFF_CREATED'
  // Memory Events
  | 'SUMMARY_CREATED'
  | 'MEMORY_EXTRACTED'
  | 'SNAPSHOT_CREATED';

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
  'WIKI_UPDATED': { topic: string; content: string };
  'RULE_ADDED': { content: string };
  'RULE_REMOVED': { content: string };
  'DECISION_RECORDED': { decision_id: string; title: string; context: string; decision: string };
  'HANDOFF_CREATED': HandoffPayload;
  'SUMMARY_CREATED': any;
  'MEMORY_EXTRACTED': any;
  'SNAPSHOT_CREATED': any;
}

