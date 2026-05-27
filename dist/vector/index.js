import { getDb } from '../db/database.js';
import { bufferToVector, vectorToBuffer, searchSparse, cosineSimilarity } from './similarity.js';
export function addMemory(projectId, type, content, embeddingVector, importance = 0.5) {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const embeddingBlob = embeddingVector ? vectorToBuffer(embeddingVector) : null;
    const result = db.prepare(`
    INSERT INTO memories (project_id, type, content, embedding, importance, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, type, content, embeddingBlob, importance, now);
    return {
        id: Number(result.lastInsertRowid),
        project_id: projectId,
        type,
        content,
        embedding: embeddingVector ? (embeddingVector instanceof Float32Array ? embeddingVector : new Float32Array(embeddingVector)) : null,
        importance,
        created_at: now
    };
}
export function getMemories(projectId, limit) {
    const db = getDb();
    // Use conditional query to avoid relying on SQLite's undocumented LIMIT -1 behavior
    const query = limit !== undefined
        ? `SELECT id, project_id, type, content, embedding, importance, created_at
       FROM memories
       WHERE project_id = ?
       ORDER BY id DESC
       LIMIT ${limit}`
        : `SELECT id, project_id, type, content, embedding, importance, created_at
       FROM memories
       WHERE project_id = ?
       ORDER BY id DESC`;
    const rows = db.prepare(query).all(projectId);
    return rows.map(r => ({
        id: Number(r.id),
        project_id: r.project_id,
        type: r.type,
        content: r.content,
        embedding: r.embedding ? bufferToVector(r.embedding) : null,
        importance: Number(r.importance),
        created_at: Number(r.created_at)
    }));
}
export function searchMemories(projectId, query, queryEmbedding, limit = 10) {
    // Fetch only recent memories to bound memory and compute cost
    // NOTE: TF-IDF scoring is done in-process on all 500 documents per search.
    // For high-frequency search patterns, this will be the first bottleneck at scale.
    // Consider adding a pre-computed inverted index if search latency becomes an issue.
    const memories = getMemories(projectId, 500);
    if (memories.length === 0)
        return [];
    const docs = memories.map(m => ({
        id: m.id,
        type: m.type,
        content: m.content,
        embedding: m.embedding,
        importance: m.importance,
        created_at: m.created_at
    }));
    const nowSecs = Math.floor(Date.now() / 1000);
    const qEmbed = queryEmbedding ? (queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding)) : null;
    let relevanceScores = [];
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
    }
    else {
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
    const results = memories.map(m => {
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
        if ((queryLower.includes('rule') && m.type === 'rule') ||
            (queryLower.includes('wiki') && m.type === 'wiki') ||
            ((queryLower.includes('decision') || queryLower.includes('adr')) && m.type === 'decision') ||
            ((queryLower.includes('summary') || queryLower.includes('handoff')) && m.type === 'summary')) {
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
