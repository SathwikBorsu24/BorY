const GeminiClient = require('../utils/geminiClient');

class AIService {
  constructor() {
    this.gemini = new GeminiClient();
  }

  getStatus() {
    return {
      selected: 'gemini',
      fallback: this.gemini.fallbackModels,
      gemini: {
        configured: this.gemini.isConfigured(),
        model: this.gemini.model,
        fallbackModels: this.gemini.fallbackModels
      }
    };
  }

  async call(systemPrompt, messages, options = {}) {
    return this.gemini.chat(systemPrompt, messages, options);
  }

  async answerQuestion(question, context, videoInfo, history = []) {
    const systemPrompt = `You are BorY, a video-grounded tutor.

Video title: ${videoInfo.title}
Channel/source: ${videoInfo.channel}

Your job is to answer the user's question using the supplied transcript as the source of truth.
Rules:
- Understand the video as a whole, not just one matching sentence.
- For broad questions, synthesize information across the transcript.
- For specific questions, use the most relevant passages and their surrounding context.
- The user may use pronouns such as "it", "that", or "this" to refer to earlier turns; use conversation history to resolve them.
- Do not invent facts that are not supported by the transcript.
- When supported, cite the exact timestamp(s) in [MM:SS] or [H:MM:SS].
- For timestamp questions, put the best timestamp(s) first and explain what is discussed there.
- If the transcript does not contain enough evidence, say: "I couldn't find that information in the available video transcript."
- Answer directly and naturally. Prefer a useful explanation over a generic summary.
- Keep technical names, formulas, examples, and terminology faithful to the transcript.`;

    const messages = [
      ...history.slice(-10).map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        content: String(h.content || '')
      })),
      {
        role: 'user',
        content: `VIDEO CONTEXT\n${context}\n\nQUESTION\n${question}\n\nBased on the preceding video context, answer the question now.`
      }
    ];

    return this.call(systemPrompt, messages, {
      maxOutputTokens: 1200,
      thinkingLevel: 'low'
    });
  }

  async generateSummary(transcript, videoInfo, type = 'quick') {
    const typeInstructions = {
      quick: 'Create a concise 3–5 sentence summary.',
      detailed: 'Create a detailed chronological summary with the major topics and supporting timestamps.',
      keypoints: 'Create 8–12 important key points. Include timestamps when supported.'
    };

    const instruction = typeInstructions[type] || typeInstructions.quick;
    const source = this.formatTranscript(transcript);
    const prepared = await this.prepareLongSource(
      source,
      `Summarize this transcript block accurately. Preserve important timestamps. ${instruction}`
    );

    const systemPrompt = `You are BorY. ${instruction}
Use markdown. Do not add information that is not in the transcript.
Video: ${videoInfo.title}
Channel/source: ${videoInfo.channel}`;

    return this.call(systemPrompt, [{ role: 'user', content: prepared }], {
      maxOutputTokens: type === 'detailed' ? 5000 : 3000
    });
  }

  formatTranscript(transcript) {
    if (typeof transcript === 'string') return transcript;
    return transcript.map(t => `[${t.timestamp}] ${t.text}`).join('\n');
  }

  async prepareLongSource(source, blockInstruction) {
    const MAX_CHARS = 180000;
    if (source.length <= MAX_CHARS) return source;

    const blocks = [];
    for (let i = 0; i < source.length; i += MAX_CHARS) {
      blocks.push(source.slice(i, i + MAX_CHARS));
    }

    const summaries = [];
    for (let i = 0; i < blocks.length; i++) {
      const result = await this.call(
        `You are preparing source notes for another model.
${blockInstruction}
Keep timestamps exactly as shown.`,
        [{ role: 'user', content: blocks[i] }],
        { maxOutputTokens: 2600 }
      );
      summaries.push(`BLOCK ${i + 1}\n${result}`);
    }

    return summaries.join('\n\n');
  }


}

module.exports = AIService;
