# BorY 


## What changed

- Gemini File API is used for uploaded media, so the app can handle the configured 25 MB upload limit.
- API keys stay on the server and are read from `.env`.
- `/api/health` reports Gemini configuration without exposing the key.
- No Google Gemini SDK dependency is required; the project uses Node.js `fetch`.

Google's Gemini API supports text, audio, and video inputs, and the File API can be used for media uploads. The app uses `gemini-3.5-flash-lite` by default. It automatically retries temporary 429/5xx errors and falls back to `gemini-3.6-flash` and then `gemini-3.8-flash` when a model is unavailable or overloaded.

## Setup

1. Install Node.js 18.18+.
2. Open this project folder in Terminal.
3. Run:

```bash
npm install
npm start
```

4. Open:

```text
http://localhost:3000
```

The included `.env` is already configured with the Gemini key supplied for this local setup.

### If you want to use a new key

Create or edit `.env`:

```env
PORT=3000
MAX_UPLOAD_MB=25

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_UPLOAD_BASE_URL=https://generativelanguage.googleapis.com/upload/v1beta

YOUTUBE_TRANSCRIPT_LANG=en
```

Do not put the key in frontend JavaScript.

## Features

### YouTube videos

If YouTube exposes captions/transcripts, BorY uses those timestamped segments. The AI then answers questions using the retrieved transcript context.

### Uploaded audio/video

For videos/audio without captions:

- Choose **Upload video/audio**.
- The server uploads the media to Gemini's File API.
- Gemini transcribes the speech with timestamps.
- The resulting transcript is stored in the local session.

Gemini's official documentation supports audio understanding and timestamped transcription, and recommends the File API for larger media.

## Gemini configuration

The app uses:

```env
GEMINI_MODEL=gemini-3.5-flash-lite
```

You can change this to another model available to your Gemini API key.

Gemini API authentication is performed server-side with `x-goog-api-key`. Google recommends environment variables such as `GEMINI_API_KEY` rather than exposing the key in client code.

## Important security note

The Gemini key supplied during setup has been placed in the local `.env` so this copy can run immediately. Because API keys should be treated as secrets, do not upload this `.env` publicly or commit it to Git. If the key has been shared anywhere public, rotate it and replace it in `.env`.

## Run

```bash
npm install
npm start
```

Expected output:

```text
BorY running at http://localhost:3000
AI provider: Gemini (gemini-3.5-flash-lite)
```

### 503 / high-demand protection

The app starts with `gemini-3.5-flash-lite`, which is a fast, lower-cost Gemini model. If Gemini temporarily returns `429`, `500`, `502`, `503`, or `504`, the server retries with exponential backoff and then tries the configured fallback models in order. A `404` for a model also moves directly to the next fallback. Authentication (`401`/`403`) and malformed requests (`400`) are surfaced immediately instead of being retried.

## Context-aware video chat
The chat layer now sends the compact video outline plus relevant timestamped passages for normal-length videos (up to `CHAT_FULL_CONTEXT_MAX_CHARS`). This prevents keyword retrieval from hiding important parts of the video. For very long videos it combines relevant passages with evenly distributed transcript coverage, and it keeps nearby transcript chunks together. Chat questions are placed after the video context so Gemini can reason over the entire supplied source.
