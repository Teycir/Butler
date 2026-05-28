import { getDb } from '../db/database.js';
import { MemoryType } from '../events/types.js';
import { MEMORY_SEARCH_LIMIT, now as getCurrentTimestamp } from '../constants.js';
import {
  bufferToVector,
  vectorToBuffer,
  searchSparse,
  cosineSimilarity,
  SearchableDocument
} from './similarity.js';

export interface MemoryRecord {
  id: number;
  project_id: string;
  type: MemoryType;
  content: string;
  source_ref: string | null;
  source_event_id: number | null;
  session_id: string | null;
  embedding: Float32Array | null;
  importance: number;
  created_at: number;
}

export function addMemory(
  projectId: string,
  type: MemoryType,
  content: string,
  embeddingVector?: number[] | Float32Array,
  importance: number = 0.5,
  sourceRef?: string,
  sourceEventId?: number,
  sessionId?: string
): MemoryRecord {
  const db = getDb();
  const now = getCurrentTimestamp();
  const embeddingBlob = embeddingVector ? vectorToBuffer(embeddingVector) : null;

  const result = db.prepare(`
    INSERT INTO memories (project_id, type, content, source_ref, source_event_id, session_id, embedding, importance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, type, source_ref) WHERE source_ref IS NOT NULL
    DO UPDATE SET content = excluded.content, source_event_id = excluded.source_event_id,
                  session_id = excluded.session_id,
                  embedding = excluded.embedding, importance = excluded.importance
  `).run(projectId, type, content, sourceRef ?? null, sourceEventId ?? null, sessionId ?? null, embeddingBlob, importance, now);

  const rowId = Number(result.lastInsertRowid);

  // Re-fetch created_at from the DB: on an upsert conflict the row is updated in-place,
  // so `now` is wrong for the returned record (the original created_at is preserved).
  const stored = db.prepare('SELECT created_at FROM memories WHERE id = ?').get(rowId) as any;
  const createdAt = stored ? Number(stored.created_at) : now;

  return {
    id: rowId,
    project_id: projectId,
    type,
    content,
    source_ref: sourceRef ?? null,
    source_event_id: sourceEventId ?? null,
    session_id: sessionId ?? null,
    embedding: embeddingVector ? (embeddingVector instanceof Float32Array ? embeddingVector : new Float32Array(embeddingVector)) : null,
    importance,
    created_at: createdAt
  };
}

/**
 * Delete a memory by ID. Returns true if a row was deleted, false if the ID
 * did not exist or belonged to a different project (prevents cross-project deletion).
 */
export function deleteMemory(projectId: string, memoryId: number): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM memories WHERE id = ? AND project_id = ?'
  ).run(memoryId, projectId);
  return result.changes > 0;
}

export function getMemories(projectId: string, limit?: number): MemoryRecord[] {
  const db = getDb();
  
  const query = limit !== undefined
    ? `SELECT id, project_id, type, content, source_ref, source_event_id, session_id, embedding, importance, created_at
       FROM memories
       WHERE project_id = ?
       ORDER BY id DESC
       LIMIT ${limit}`
    : `SELECT id, project_id, type, content, source_ref, source_event_id, session_id, embedding, importance, created_at
       FROM memories
       WHERE project_id = ?
       ORDER BY id DESC`;
  
  const rows = db.prepare(query).all(projectId) as any[];

  return rows.map(r => ({
    id: Number(r.id),
    project_id: r.project_id,
    type: r.type as any,
    content: r.content,
    source_ref: r.source_ref ?? null,
    source_event_id: r.source_event_id ? Number(r.source_event_id) : null,
    session_id: r.session_id ?? null,
    embedding: r.embedding ? bufferToVector(r.embedding) : null,
    importance: Number(r.importance),
    created_at: Number(r.created_at)
  }));
}

export interface SearchResult {
  memory: MemoryRecord;
  relevance: number;
  recency: number;
  importance: number;
  score: number;
}

export function searchMemories(
  projectId: string,
  query: string,
  queryEmbedding?: Float32Array | number[],
  limit: number = 10
): SearchResult[] {
  // Fetch recent memories to bound compute cost
  const memories = getMemories(projectId, MEMORY_SEARCH_LIMIT);
  if (memories.length === 0) return [];

  const docs: SearchableDocument[] = memories.map(m => ({
    id: m.id,
    type: m.type,
    content: m.content,
    embedding: m.embedding,
    importance: m.importance,
    created_at: m.created_at
  }));

  const nowSecs = Math.floor(Date.now() / 1000);
  const qEmbed = queryEmbedding ? (queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding)) : null;

  let relevanceScores: Array<{ id: number; score: number }> = [];

  // If a dense query embedding is provided AND database memories contain dense embeddings, do cosine similarity
  if (qEmbed && docs.some(d => d.embedding !== null)) {
    relevanceScores = docs.map(d => {
      let sim = 0;
      if (d.embedding) {
        sim = cosineSimilarity(qEmbed, d.embedding);
        // Normalize cosine score from [-1, 1] to [0, 1]
        sim = (sim + 1) / 2;
      }
      return { id: d.id, score: sim };
    });
  } else {
    // Zero-config, local TF-IDF sparse keyword matching
    const sparseResults = searchSparse(query, docs);
    
    // Find maximum score to normalize to [0, 1]
    const maxScore = Math.max(...sparseResults.map(r => r.score), 1e-5);
    
    relevanceScores = sparseResults.map(r => ({
      id: r.doc.id,
      score: r.score / maxScore
    }));
  }

  const relevanceMap = new Map(relevanceScores.map(item => [item.id, item.score]));

  const results: SearchResult[] = memories.map(m => {
    const rel = relevanceMap.get(m.id) || 0;
    
    // Calculate recency: e^(-lambda * t_hours)
    // Use lambda = 0.001 for ~29-day half-life (better for project knowledge)
    const ageHours = Math.max(0, (nowSecs - m.created_at) / 3600);
    const lambda = 0.001;
    const rec = Math.exp(-lambda * ageHours);
    
    const imp = m.importance;
    
    // Dynamic project relevance: boost memories where the category aligns with the query term intent
    let projectRelevance = 0.5;
    const queryLower = query.toLowerCase();
    if (
      (queryLower.includes('rule') && m.type === 'rule') ||
      (queryLower.includes('wiki') && m.type === 'wiki') ||
      ((queryLower.includes('decision') || queryLower.includes('adr')) && m.type === 'decision') ||
      ((queryLower.includes('summary') || queryLower.includes('handoff')) && m.type === 'summary')
    ) {
      projectRelevance = 1.0;
    }

    // Combined formula: similarity*0.5 + recency*0.2 + importance*0.2 + projectRelevance*0.1
    const combinedScore = (rel * 0.5) + (rec * 0.2) + (imp * 0.2) + (projectRelevance * 0.1);

    return {
      memory: m,
      relevance: rel,
      recency: rec,
      importance: imp,
      score: combinedScore
    };
  });

  // Sort descending
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
