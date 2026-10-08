const { YoutubeTranscript } = require('youtube-transcript');

class TranscriptService {
  constructor() {
    this.language = process.env.YOUTUBE_TRANSCRIPT_LANG || 'en';
  }

  async getTranscript(videoId) {
    const errors = [];

    // Method 1: youtube-transcript package
    try {
      const raw = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: this.language
      });

      const parsed = this.normalize(raw);

      if (parsed.length) {
        return parsed;
      }
    } catch (err) {
      errors.push(`youtube-transcript: ${err.message}`);
      console.error(errors.at(-1));
    }

    // Method 2: YouTube InnerTube player endpoint
    try {
      const parsed = await this.getViaInnerTube(videoId);

      if (parsed.length) {
        return parsed;
      }
    } catch (err) {
      errors.push(`InnerTube: ${err.message}`);
      console.error(errors.at(-1));
    }

    // Method 3: YouTube watch page captionTracks fallback
    try {
      const parsed = await this.getViaWatchPage(videoId);

      if (parsed.length) {
        return parsed;
      }
    } catch (err) {
      errors.push(`watch page: ${err.message}`);
      console.error(errors.at(-1));
    }

    const error = new Error(
      `No usable caption track was found. Details: ${errors.join(' | ')}`
    );

    error.details = errors;
    throw error;
  }

  async getViaInnerTube(videoId) {
    const apiUrl =
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38'
          }
        },
        videoId
      })
    });

    if (!resp.ok) {
      throw new Error(`InnerTube returned HTTP ${resp.status}`);
    }

    const data = await resp.json();

    const tracks =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new Error('No caption tracks were exposed by the player.');
    }

    const preferred = tracks.find(
      (track) => track.languageCode === this.language
    );

    const english = tracks.find(
      (track) => track.languageCode === 'en'
    );

    const track = preferred || english || tracks[0];

    if (!track?.baseUrl) {
      throw new Error('Caption track did not include a base URL.');
    }

    return this.fetchTimedText(track.baseUrl);
  }

  async getViaWatchPage(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!resp.ok) {
      throw new Error(
        `YouTube watch page returned HTTP ${resp.status}`
      );
    }

    const html = await resp.text();

    const marker = '"captionTracks":';
    const start = html.indexOf(marker);

    if (start < 0) {
      throw new Error('captionTracks not found');
    }

    const arrayStart = html.indexOf('[', start);

    if (arrayStart < 0) {
      throw new Error('captionTracks array not found');
    }

    const end = this.findMatchingBracket(html, arrayStart);

    if (end < 0) {
      throw new Error('captionTracks array was truncated');
    }

    let tracks;

    try {
      tracks = JSON.parse(
        html.slice(arrayStart, end + 1)
      );
    } catch {
      throw new Error('captionTracks JSON could not be parsed');
    }

    const preferred = tracks.find(
      (track) => track.languageCode === this.language
    );

    const english = tracks.find(
      (track) => track.languageCode === 'en'
    );

    const track = preferred || english || tracks[0];

    if (!track?.baseUrl) {
      throw new Error('Caption track did not include a base URL.');
    }

    return this.fetchTimedText(track.baseUrl);
  }

  findMatchingBracket(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }

        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;

        if (depth === 0) {
          return i;
        }
      }
    }

    return -1;
  }

  async fetchTimedText(baseUrl) {
    const url = new URL(baseUrl);

    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!resp.ok) {
      throw new Error(
        `Timedtext returned HTTP ${resp.status}`
      );
    }

    const text = await resp.text();

    if (!text.trim()) {
      throw new Error('Empty timedtext response');
    }

    // Try XML first
    const xmlSegments = [
      ...this.parseSrv3Format(text),
      ...this.parseClassicXml(text)
    ];

    if (xmlSegments.length) {
      return xmlSegments;
    }

    // Try JSON3
    const jsonUrl = new URL(baseUrl);
    jsonUrl.searchParams.set('fmt', 'json3');

    const jsonResp = await fetch(jsonUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (jsonResp.ok) {
      const data = await jsonResp.json();

      const events = Array.isArray(data?.events)
        ? data.events
        : [];

      const result = [];

      for (const event of events) {
        const segs = Array.isArray(event.segs)
          ? event.segs
          : [];

        const phrase = segs
          .map((segment) => segment.utf8 || '')
          .join('')
          .trim();

        if (!phrase) {
          continue;
        }

        const start =
          Number(event.tStartMs || 0) / 1000;

        const duration =
          Number(event.dDurationMs || 0) / 1000;

        result.push({
          text: this.cleanText(phrase),
          start,
          duration,
          timestamp: this.formatTimestamp(start)
        });
      }

      if (result.length) {
        return result;
      }
    }

    throw new Error(
      'Could not parse the caption format returned by YouTube.'
    );
  }

  parseSrv3Format(text) {
    if (!/<p\b/i.test(text)) {
      return [];
    }

    const result = [];
    const regex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;

    let match;

    while ((match = regex.exec(text))) {
      const attrs = match[1];
      const body = match[2];

      const t = this.getAttr(attrs, 't');
      const d = this.getAttr(attrs, 'd');

      const start =
        t == null ? 0 : Number(t) / 1000;

      const duration =
        d == null ? 0 : Number(d) / 1000;

      const segmentText = body
        .replace(/<s\b[^>]*>/gi, '')
        .replace(/<\/s>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (segmentText) {
        result.push({
          text: this.cleanText(segmentText),
          start,
          duration,
          timestamp: this.formatTimestamp(start)
        });
      }
    }

    return result;
  }

  parseClassicXml(text) {
    if (!/<text\b/i.test(text)) {
      return [];
    }

    const result = [];
    const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;

    let match;

    while ((match = regex.exec(text))) {
      const attrs = match[1];
      const rawText = match[2];

      const start = Number(
        this.getAttr(attrs, 'start') || 0
      );

      const duration = Number(
        this.getAttr(attrs, 'dur') || 0
      );

      const phrase = this
        .decodeXml(rawText)
        .replace(/\s+/g, ' ')
        .trim();

      if (phrase) {
        result.push({
          text: this.cleanText(phrase),
          start,
          duration,
          timestamp: this.formatTimestamp(start)
        });
      }
    }

    return result;
  }

  normalize(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((item) => {
        const start =
          item.offset != null
            ? Number(item.offset) / 1000
            : Number(item.start || 0);

        const duration =
          Number(item.duration || 0) / 1000;

        return {
          text: this.cleanText(item.text || ''),
          start,
          duration,
          timestamp: this.formatTimestamp(start)
        };
      })
      .filter((item) => item.text);
  }

  getAttr(attrs, name) {
    const match = attrs.match(
      new RegExp(
        `${name}=["']([^"']+)["']`,
        'i'
      )
    );

    return match ? match[1] : null;
  }

  cleanText(text) {
    return this
      .decodeXml(String(text))
      .replace(/&amp;/g, '&')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  decodeXml(text) {
    return String(text)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(
        /&#(\d+);/g,
        (_, n) => String.fromCharCode(Number(n))
      )
      .replace(
        /&#x([0-9a-f]+);/gi,
        (_, n) => String.fromCharCode(parseInt(n, 16))
      );
  }

  formatTimestamp(seconds) {
    const hrs = Math.floor(seconds / 3600);

    const mins = Math.floor(
      (seconds % 3600) / 60
    );

    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(
        secs
      ).padStart(2, '0')}`;
    }

    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}

module.exports = TranscriptService;
