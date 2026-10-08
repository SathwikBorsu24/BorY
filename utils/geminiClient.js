const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class GeminiClient {
  constructor({ apiKey, baseUrl, model, fallbackModels = [] }) {
    this.apiKey = apiKey || '';
    this.baseUrl = String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.model = model || 'gemini-3.5-flash-lite';
    this.fallbackModels = Array.isArray(fallbackModels) ? fallbackModels : [];
    this.models = [...new Set([this.model, ...this.fallbackModels].filter(Boolean))];
    this.maxRetriesPerModel = 1;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async generateContent(body) {
    if (!this.isConfigured()) {
      const err = new Error('Gemini API key is not configured. Set GEMINI_API_KEY in .env');
      err.code = 'AUTH';
      throw err;
    }

    let lastError = null;

    for (const model of this.models) {
      for (let attempt = 0; attempt <= this.maxRetriesPerModel; attempt++) {
        let resp;
        try {
          resp = await fetch(
            `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.apiKey
              },
              body: JSON.stringify(body)
            }
          );
        } catch (networkError) {
          lastError = new Error(`Gemini network error: ${networkError.message}`);
          lastError.code = 'NETWORK';
          if (attempt < this.maxRetriesPerModel) {
            await sleep(500 * (2 ** attempt));
            continue;
          }
          break;
        }

        if (resp.ok) {
          return { data: await resp.json(), model };
        }

        const details = await resp.text();
        const transient = [429, 500, 502, 503, 504].includes(resp.status);
        const notFound = resp.status === 404;

        lastError = new Error(`Gemini API error (${resp.status}) on ${model}: ${details}`);
        lastError.status = resp.status;
        lastError.model = model;
        lastError.code =
          resp.status === 401 || resp.status === 403 ? 'AUTH' :
          resp.status === 404 ? 'MODEL' :
          resp.status === 429 ? 'RATE_LIMIT' :
          transient ? 'TEMPORARY' :
          resp.status === 400 ? 'BAD_REQUEST' :
          'SERVER';

        if (resp.status === 401 || resp.status === 403 || resp.status === 400) {
          throw lastError;
        }

        // A missing model is not retryable, so immediately try the next configured model.
        if (notFound) break;

        if (transient && attempt < this.maxRetriesPerModel) {
          const retryAfter = Number(resp.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : 600 * (2 ** attempt);
          await sleep(waitMs);
          continue;
        }

        // Move to the next model after the retry budget is exhausted.
        break;
      }
    }

    if (lastError) {
      lastError.message += ` Tried models: ${this.models.join(', ')}.`;
      throw lastError;
    }

    const err = new Error('Gemini request failed before a response was received.');
    err.code = 'SERVER';
    throw err;
  }
}

module.exports = GeminiClient;
