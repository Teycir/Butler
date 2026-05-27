const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'arent',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'cant', 'cannot', 'could', 'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'hadnt', 'has', 'hasnt', 'have',
  'havent', 'having', 'he', 'hed', 'hell', 'hes', 'her', 'here', 'heres', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'hows', 'i', 'id', 'ill', 'im', 'ive', 'if', 'in', 'into', 'is', 'isnt',
  'it', 'its', 'itself', 'lets', 'me', 'more', 'most', 'mustnt', 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', 'shant', 'she', 'shed', 'shell', 'shes', 'should', 'shouldnt', 'so', 'some', 'such',
  'than', 'that', 'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'theres',
  'these', 'they', 'theyd', 'theyll', 'theyre', 'theyve', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'wasnt', 'we', 'wed', 'well', 'were', 'weve', 'werent',
  'what', 'whats', 'when', 'whens', 'where', 'wheres', 'which', 'while', 'who', 'whos', 'whom',
  'why', 'whys', 'with', 'wont', 'would', 'wouldnt', 'you', 'youd', 'youll', 'youre', 'youve',
  'your', 'yours', 'yourself', 'yourselves'
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Calculates standard cosine similarity between two dense Float32 arrays.
 */
export function cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Helper to serialize Float32Array to Buffer for storing in database
 */
export function vectorToBuffer(vector: number[] | Float32Array): Buffer {
  const floats = vector instanceof Float32Array ? vector : new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * Helper to deserialize Buffer to Float32Array
 */
export function bufferToVector(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export interface SearchableDocument {
  id: number;
  type: 'summary' | 'decision' | 'rule' | 'wiki';
  content: string;
  embedding: Float32Array | null;
  importance: number;
  created_at: number;
}

/**
 * Computes TF-IDF scores for a collection of local documents.
 * Standard tf-idf based keyword similarity is incredibly effective for local project contexts.
 */
export function searchSparse(
  query: string,
  documents: SearchableDocument[]
): Array<{ doc: SearchableDocument; score: number }> {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return documents.map(doc => ({ doc, score: 0 }));
  }

  const numDocs = documents.length;
  
  // Calculate Document Frequency (DF)
  const df: Record<string, number> = {};
  for (const doc of documents) {
    const terms = new Set(tokenize(doc.content));
    for (const term of terms) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  // Calculate Inverse Document Frequency (IDF) for query terms
  const idf: Record<string, number> = {};
  for (const term of queryTerms) {
    const docFreq = df[term] || 0;
    // Standard smoothed IDF
    idf[term] = Math.log(1 + (numDocs - docFreq + 0.5) / (docFreq + 0.5));
  }

  // Score each document
  const scored = documents.map(doc => {
    const docTerms = tokenize(doc.content);
    
    // Term frequencies
    const tf: Record<string, number> = {};
    for (const term of docTerms) {
      tf[term] = (tf[term] || 0) + 1;
    }

    let rawScore = 0;
    for (const term of queryTerms) {
      if (tf[term]) {
        // TF * IDF
        rawScore += tf[term] * idf[term];
      }
    }

    // Normalize rawScore by document length (to prevent favoring long wiki pages excessively)
    const docLengthNormalized = docTerms.length > 0 ? rawScore / Math.sqrt(docTerms.length) : 0;

    return {
      doc,
      score: docLengthNormalized
    };
  });

  return scored;
}
