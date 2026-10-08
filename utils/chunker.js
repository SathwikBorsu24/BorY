function chunkTranscript(transcript, chunkDurationSec = 90, overlapSec = 18) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];

  const chunks = [];
  const sorted = transcript
    .filter(s => s && typeof s.text === 'string' && s.text.trim())
    .slice()
    .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));

  if (!sorted.length) return [];

  let startIndex = 0;
  let chunkStart = Number(sorted[0].start || 0);

  while (startIndex < sorted.length) {
    const endTime = chunkStart + chunkDurationSec;
    const selected = [];

    for (let i = startIndex; i < sorted.length; i++) {
      const start = Number(sorted[i].start || 0);
      if (selected.length && start >= endTime) break;
      selected.push(sorted[i]);
    }

    if (!selected.length) break;
    chunks.push(buildChunk(selected, chunkStart));

    const nextStartTime = Math.max(chunkStart + (chunkDurationSec - overlapSec), chunkStart + 1);
    let nextIndex = sorted.findIndex((seg, idx) => idx > startIndex && Number(seg.start || 0) >= nextStartTime);
    if (nextIndex === -1) break;

    startIndex = nextIndex;
    chunkStart = Number(sorted[startIndex].start || nextStartTime);
  }

  return chunks;
}

function buildChunk(segments, startTime) {
  const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const last = segments[segments.length - 1];

  return {
    text,
    start: Number(startTime || 0),
    end: Number(last.start || 0) + Number(last.duration || 0),
    timestamp: formatTimestamp(startTime),
    segments
  };
}

function retrieveRelevantChunks(question, chunks, topK = 12) {
  if (!Array.isArray(chunks) || !chunks.length) return [];

  const query = normalize(String(question || ''));
  const queryTokens = tokenize(query);
  const queryTerms = new Set(queryTokens);
  const broad = isBroadQuestion(query);

  if (!queryTokens.length || broad) {
    return selectCoverageChunks(chunks, Math.max(topK, 16));
  }

  const documentFrequency = new Map();
  const tokenizedChunks = chunks.map(chunk => {
    const tokens = tokenize(chunk.text);
    const seen = new Set(tokens);
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    return tokens;
  });

  const totalDocs = chunks.length;
  const scored = chunks.map((chunk, index) => {
    const tokens = tokenizedChunks[index];
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const count = counts.get(term) || 0;
      if (!count) continue;
      const df = documentFrequency.get(term) || 1;
      const idf = Math.log((totalDocs + 1) / (df + 0.5)) + 1;
      score += idf * (1 + Math.log(count));

      if (term.length >= 5) {
        for (const candidate of counts.keys()) {
          if (candidate !== term && (candidate.startsWith(term) || term.startsWith(candidate))) {
            score += idf * 0.25;
          }
        }
      }
    }

    const lowerText = normalize(chunk.text);
    const phrase = queryTokens.length >= 2 ? queryTokens.join(' ') : '';
    if (phrase && lowerText.includes(phrase)) score += 8;

    // Stronger weighting for terms near each other in the transcript.
    const positions = [];
    for (let i = 0; i < tokens.length; i++) {
      if (queryTerms.has(tokens[i])) positions.push(i);
    }
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] - positions[i - 1] <= 6) score += 1.5;
    }

    return { chunk, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = scored.filter(x => x.score > 0).slice(0, topK).map(x => x.index);

  if (!selected.length) return selectCoverageChunks(chunks, Math.max(topK, 16));

  const expanded = new Set(selected);
  for (const index of selected) {
    if (index > 0) expanded.add(index - 1);
    if (index + 1 < chunks.length) expanded.add(index + 1);
  }

  return Array.from(expanded)
    .sort((a, b) => a - b)
    .slice(0, Math.min(topK + 8, chunks.length))
    .map(i => chunks[i]);
}

function selectCoverageChunks(chunks, maxChunks = 16) {
  if (!chunks.length) return [];
  if (chunks.length <= maxChunks) return chunks.slice();

  const indexes = new Set();
  const step = (chunks.length - 1) / (maxChunks - 1);
  for (let i = 0; i < maxChunks; i++) indexes.add(Math.round(i * step));

  return Array.from(indexes).sort((a, b) => a - b).map(i => chunks[i]);
}

function isBroadQuestion(query) {
  const broadSignals = [
    'main topic', 'main idea', 'overall', 'overview', 'summarize', 'summary',
    'important concepts', 'important points', 'key concepts', 'key points',
    'most important', 'what is this video about', 'what does this video explain',
    'explain the video', 'give me the examples', 'examples mentioned',
    'all examples', 'everything about', 'what did they cover', 'topics covered',
    'cover in this video', 'conclusion', 'takeaways', 'what should i learn'
  ];
  return broadSignals.some(signal => query.includes(signal));
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const stopWords = new Set([
    'the','was','what','where','when','how','why','who','did','does','are','you',
    'tell','about','explain','give','show','find','mention','mentioned','said',
    'talk','talked','discuss','discussed','from','this','that','with','for','and',
    'but','not','have','has','had','been','being','their','there','they','them',
    'then','than','also','just','only','very','can','could','should','would',
    'will','shall','may','might','must','need','like','want','know','video',
    'timestamp','time','please','tell','me','did','does','do','is','it','its','to'
  ]);

  return normalize(text)
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

module.exports = {
  chunkTranscript,
  retrieveRelevantChunks,
  buildChunk,
  formatTimestamp,
  selectCoverageChunks
};
