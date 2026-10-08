require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const YouTubeService = require('./services/youtubeService');
const TranscriptService = require('./services/transcriptService');
const SpeechService = require('./services/speechService');
const AIService = require('./services/aiService');
const { chunkTranscript, retrieveRelevantChunks, selectCoverageChunks } = require('./utils/chunker');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowedPrefixes = ['video/', 'audio/'];
    if (!allowedPrefixes.some(prefix => file.mimetype.startsWith(prefix))) {
      return cb(new Error('Please upload an audio or video file.'));
    }
    cb(null, true);
  }
});

const youtubeService = new YouTubeService();
const transcriptService = new TranscriptService();
const speechService = new SpeechService();
const aiService = new AIService();

// In-memory session store.
// This is intentionally simple for local development.
const sessions = new Map();

function createSessionId(prefix = 'session') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertSession(videoId) {
  const session = sessions.get(videoId);
  if (!session) {
    const error = new Error('Video has not been analyzed yet. Please analyze it first.');
    error.status = 404;
    throw error;
  }
  return session;
}


app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ai: aiService.getStatus(),
    maxUploadMB: MAX_UPLOAD_MB
  });
});

// ─── Analyze YouTube URL ───────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'YouTube URL is required.' });

    const videoId = youtubeService.extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL.' });

    const videoInfo = await youtubeService.getVideoInfo(videoId);

    let transcript = null;
    let captionError = null;

    try {
      transcript = await transcriptService.getTranscript(videoId);
    } catch (err) {
      captionError = err.message;
      console.error('Caption retrieval failed:', err);
    }

    if (!transcript || transcript.length === 0) {
      return res.status(422).json({
        error: 'This YouTube video does not expose a usable transcript/caption track.',
        code: 'NO_CAPTIONS',
        hint: 'Use the "Upload video/audio" option for a file you own or have permission to process.',
        details: captionError || undefined
      });
    }

    const chunks = chunkTranscript(transcript, 90, 18);
    const sessionId = videoId;

    sessions.set(sessionId, {
      sessionId,
      videoId,
      source: 'youtube-captions',
      videoInfo: { ...videoInfo, source: 'youtube-captions' },
      transcript,
      chunks,
      createdAt: Date.now()
    });

    res.json({
      sessionId,
      videoId,
      source: 'youtube-captions',
      videoInfo: { ...videoInfo, source: 'youtube-captions' },
      transcript,
      chunkCount: chunks.length
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to analyze video.' });
  }
});

// ─── Analyze uploaded media without captions ──────────────────────────
app.post('/api/analyze-upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please choose an audio or video file.' });

    if (!speechService.isConfigured()) {
      return res.status(503).json({
        error: 'Upload transcription is not configured. Add GEMINI_API_KEY to .env.'
      });
    }

    const transcript = await speechService.transcribeBuffer({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype
    });

    if (!transcript.length) {
      return res.status(422).json({ error: 'No speech could be detected in the uploaded file.' });
    }

    const sessionId = createSessionId('upload');
    const safeTitle = path.basename(req.file.originalname, path.extname(req.file.originalname)) || 'Uploaded media';

    const videoInfo = {
      videoId: sessionId,
      title: safeTitle,
      channel: 'Uploaded media',
      thumbnail: '',
      thumbnailFallback: '',
      embedUrl: '',
      watchUrl: '',
      source: 'upload',
      fileName: req.file.originalname,
      mimeType: req.file.mimetype
    };

    const chunks = chunkTranscript(transcript, 90, 18);

    sessions.set(sessionId, {
      sessionId,
      videoId: sessionId,
      source: 'upload',
      videoInfo,
      transcript,
      chunks,
      createdAt: Date.now()
    });

    res.json({
      sessionId,
      videoId: sessionId,
      source: 'upload',
      videoInfo,
      transcript,
      chunkCount: chunks.length
    });
  } catch (err) {
    console.error('Upload analysis error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to transcribe uploaded media.' });
  }
});

// Build a compact context window for fast chat while preserving global video coverage.
function buildQuestionContext(question, session, relevantChunks) {
  const coverageCount = Number(process.env.CHAT_COVERAGE_CHUNKS || 14);
  const maxOutlineChars = Number(process.env.CHAT_OUTLINE_MAX_CHARS || 9000);
  const isBroad = /\b(main|overall|summary|summarize|overview|important|key points?|concepts?|examples?|topics?|what is this video|what does this video|everything|covered)\b/i.test(question);

  const selected = new Map();
  const detailChunks = isBroad
    ? selectCoverageChunks(session.chunks, coverageCount)
    : relevantChunks.slice(0, 8);

  for (const chunk of detailChunks) {
    selected.set(`${chunk.start}-${chunk.end}`, chunk);
  }

  // Add immediate neighboring chunks to preserve explanations that cross chunk boundaries.
  for (const chunk of detailChunks) {
    const index = session.chunks.indexOf(chunk);
    if (index > 0) selected.set(`${session.chunks[index - 1].start}-${session.chunks[index - 1].end}`, session.chunks[index - 1]);
    if (index + 1 < session.chunks.length) selected.set(`${session.chunks[index + 1].start}-${session.chunks[index + 1].end}`, session.chunks[index + 1]);
  }

  // A tiny deterministic outline gives Gemini a map of the whole video without
  // sending the full transcript on every question.
  let outline = '';
  for (const chunk of session.chunks) {
    const preview = chunk.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    const line = `[${chunk.timestamp}] ${preview}\n`;
    if ((outline.length + line.length) > maxOutlineChars) break;
    outline += line;
  }

  return [
    '=== VIDEO OUTLINE ===',
    outline.trim(),
    '=== DETAILED VIDEO PASSAGES ===',
    Array.from(selected.values())
      .sort((a, b) => a.start - b.start)
      .map(c => `[${c.timestamp}] ${c.text}`)
      .join('\n'),
    '=== END VIDEO CONTEXT ==='
  ].join('\n\n');
}

// ─── Chat ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { videoId, question, history } = req.body || {};
    if (!videoId || !question) {
      return res.status(400).json({ error: 'videoId and question are required.' });
    }

    const session = assertSession(videoId);
    const relevantChunks = retrieveRelevantChunks(question, session.chunks, 12);
    const context = buildQuestionContext(question, session, relevantChunks);

    // Do not send the current question twice.
    const incomingHistory = Array.isArray(history) ? history : [];
    const conversationHistory =
      incomingHistory.length && incomingHistory[incomingHistory.length - 1]?.content === question
        ? incomingHistory.slice(0, -1)
        : incomingHistory;

    const answer = await aiService.answerQuestion(
      question,
      context,
      session.videoInfo,
      conversationHistory.slice(-10)
    );

    res.json({
      answer,
      relevantTimestamps: relevantChunks.map(c => c.timestamp),
      source: session.source
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to answer question.' });
  }
});

// ─── Summary ──────────────────────────────────────────────────────────
app.post('/api/summary', async (req, res) => {
  try {
    const { videoId, type = 'quick' } = req.body || {};
    const session = assertSession(videoId);
    const summary = await aiService.generateSummary(session.transcript, session.videoInfo, type);
    res.json({ summary });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to generate summary.' });
  }
});

// Serve the SPA.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File is too large. Maximum size is ${MAX_UPLOAD_MB} MB.` });
    }
  }
  res.status(400).json({ error: err.message || 'Request failed.' });
});

app.listen(PORT, () => {
  console.log(`\nBorY running at http://localhost:${PORT}`);
  console.log(`AI provider: Gemini (${process.env.GEMINI_MODEL || 'gemini-3.8-flash'})`);
  console.log(`Upload transcription: ${speechService.isConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(`Max upload: ${MAX_UPLOAD_MB} MB\n`);
});
