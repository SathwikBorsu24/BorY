const GeminiClient = require('../utils/geminiClient');

class SpeechService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    this.baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.uploadBaseUrl = (process.env.GEMINI_UPLOAD_BASE_URL || 'https://generativelanguage.googleapis.com/upload/v1beta').replace(/\/+$/, '');
    this.model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    this.fallbackModels = String(process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-3.8-flash')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this.client = new GeminiClient({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      fallbackModels: this.fallbackModels
    });
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async transcribeBuffer({ buffer, filename, mimetype }) {
    if (!this.isConfigured()) {
      throw new Error('GEMINI_API_KEY is required for upload transcription.');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('Uploaded media is empty.');
    }

    const file = await this.uploadFile(buffer, filename || 'upload', mimetype || 'application/octet-stream');

    const prompt = `Transcribe all spoken words in this audio/video accurately.

Return ONLY valid JSON with this exact shape:
{
  "segments": [
    {
      "start": 0,
      "end": 4.2,
      "text": "spoken words"
    }
  ]
}

Rules:
- Include every meaningful spoken segment in chronological order.
- "start" and "end" are seconds from the beginning of the media.
- Keep the original wording as closely as possible.
- Do not summarize.
- Do not add commentary.
- If there is no speech, return {"segments":[]}.`;

    const { data } = await this.client.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          {
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.uri
            }
          }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 20000
      }
    });

    const raw = (data.candidates || [])
      .flatMap(candidate => candidate.content?.parts || [])
      .filter(part => typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim();

    if (!raw) {
      throw new Error('Gemini returned an empty transcription.');
    }

    const parsed = this.parseTranscriptJSON(raw);
    if (!parsed.length) {
      throw new Error('Gemini returned no timestamped speech segments.');
    }

    return parsed;
  }

  async uploadFile(buffer, filename, mimeType) {
    const startResp = await fetch(`${this.uploadBaseUrl}/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file: {
          display_name: filename
        }
      })
    });

    if (!startResp.ok) {
      const details = await startResp.text();
      throw new Error(`Gemini file upload initialization failed (${startResp.status}): ${details}`);
    }

    const uploadUrl =
      startResp.headers.get('x-goog-upload-url') ||
      startResp.headers.get('X-Goog-Upload-URL') ||
      startResp.headers.get('location');

    if (!uploadUrl) {
      throw new Error('Gemini did not return a resumable upload URL.');
    }

    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(buffer.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Type': mimeType
      },
      body: buffer
    });

    if (!uploadResp.ok) {
      const details = await uploadResp.text();
      throw new Error(`Gemini file upload failed (${uploadResp.status}): ${details}`);
    }

    const data = await uploadResp.json();
    const file = data.file || data;
    if (!file.uri) {
      throw new Error('Gemini file upload completed without a file URI.');
    }

    return {
      uri: file.uri,
      mimeType: file.mimeType || mimeType
    };
  }

  parseTranscriptJSON(raw) {
    const cleaned = String(raw)
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end <= start) return [];
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return [];
      }
    }

    const segments = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.segments)
        ? parsed.segments
        : [];

    return segments
      .map((seg, index) => {
        const start = this.toSeconds(seg.start ?? seg.timestamp ?? 0);
        const end = this.toSeconds(seg.end ?? start);
        return {
          text: String(seg.text || seg.content || '').trim(),
          start,
          duration: Math.max(0, end - start),
          timestamp: this.formatTimestamp(start),
          _index: index
        };
      })
      .filter(s => s.text)
      .sort((a, b) => a.start - b.start)
      .map(({ _index, ...segment }) => segment);
  }

  toSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);

    const str = String(value ?? '').trim();
    if (!str) return 0;

    if (/^\d+(\.\d+)?$/.test(str)) return Math.max(0, Number(str));

    const parts = str.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return 0;

    if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
    return 0;
  }

  formatTimestamp(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}

module.exports = SpeechService;
