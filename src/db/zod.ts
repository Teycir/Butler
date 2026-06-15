import { z } from 'zod';

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.number()
});

export const sessionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  client_type: z.string(),
  status: z.enum(['alive', 'stale', 'dead']),
  created_at: z.number(),
  last_heartbeat: z.number(),
  last_event_seen: z.number()
});

export const eventSchema = z.object({
  id: z.number(),
  project_id: z.string(),
  session_id: z.string(),
  type: z.string(),
  payload: z.string(),
  created_at: z.number()
});

export const snapshotSchema = z.object({
  id: z.number(),
  project_id: z.string(),
  event_id: z.number(),
  snapshot_json: z.string(),
  sha256_hex: z.string().nullable().optional(),
  schema_version: z.number().nullable().optional(),
  created_at: z.number()
});

export function parseProject(row: unknown) {
  return projectSchema.parse(row);
}

export function parseProjects(rows: unknown[]) {
  return z.array(projectSchema).parse(rows);
}

export function parseSession(row: unknown) {
  return sessionSchema.parse(row);
}

export function parseSessions(rows: unknown[]) {
  return z.array(sessionSchema).parse(rows);
}

export function parseEvent(row: unknown) {
  return eventSchema.parse(row);
}

export function parseEvents(rows: unknown[]) {
  return z.array(eventSchema).parse(rows);
}

export function parseSnapshot(row: unknown) {
  return snapshotSchema.parse(row);
}
