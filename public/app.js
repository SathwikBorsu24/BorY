let currentVideoId = null;
let currentVideoInfo = null;
let currentTranscript = null;
let currentSource = null;
let localVideoUrl = null;
let chatHistory = [];
let isProcessing = false;

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId)?.classList.add('active');
}

function goHome() {
  if (localVideoUrl) {
    URL.revokeObjectURL(localVideoUrl);
    localVideoUrl = null;
  }
  const localVideo = document.getElementById('local-video');
  if (localVideo) {
    localVideo.pause();
    localVideo.removeAttribute('src');
    localVideo.load();
  }

  showView('landing-view');
  document.getElementById('url-input').value = '';
  document.getElementById('media-file').value = '';
  document.getElementById('url-error').classList.remove('show');
  currentVideoId = null;
  currentVideoInfo = null;
  currentTranscript = null;
  currentSource = null;
  chatHistory = [];
  closeOutputPanel();
}

async function analyzeVideo() {
  const urlInput = document.getElementById('url-input');
  const errorEl = document.getElementById('url-error');
  const btn = document.getElementById('analyze-btn');
  const url = urlInput.value.trim();

  errorEl.classList.remove('show');

  if (!url) {
    showInputError('Please paste a YouTube URL.');
    return;
  }

  setBusy(btn, true, 'Analyzing...');

  showView('loading-view');
  updateLoadingText('Reading YouTube captions...', 'Trying multiple transcript sources');

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await safeJson(resp);

    if (!resp.ok) {
      if (data.code === 'NO_CAPTIONS') {
        showView('landing-view');
        showInputError(
          `${data.error} ${data.hint || ''}`.trim()
        );
        return;
      }
      throw new Error(data.error || 'Failed to analyze video.');
    }

    updateLoadingText('Processing transcript...', 'Building timestamp-aware search context');
    finishAnalysis(data);
  } catch (err) {
    console.error(err);
    showView('landing-view');
    showInputError(err.message || 'Unable to analyze this video.');
  } finally {
    setBusy(btn, false, 'Analyze Video');
  }
}

async function analyzeUploadedMedia() {
  const input = document.getElementById('media-file');
  const errorEl = document.getElementById('url-error');
  const btn = document.getElementById('upload-btn');
  const file = input.files?.[0];

  errorEl.classList.remove('show');

  if (!file) {
    showInputError('Choose an audio or video file first.');
    return;
  }

  const maxMb = 25;
  if (file.size > maxMb * 1024 * 1024) {
    showInputError(`The upload is too large. Keep it under ${maxMb} MB.`);
    return;
  }

  setBusy(btn, true, 'Transcribing...');

  showView('loading-view');
  updateLoadingText('Transcribing uploaded media...', 'Speech-to-text is creating timestamped segments');

  try {
    const form = new FormData();
    form.append('media', file);

    const resp = await fetch('/api/analyze-upload', {
      method: 'POST',
      body: form
    });

    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data.error || 'Failed to transcribe uploaded media.');

    localVideoUrl = URL.createObjectURL(file);
    finishAnalysis(data);
  } catch (err) {
    console.error(err);
    showView('landing-view');
    showInputError(err.message || 'Unable to transcribe this file.');
  } finally {
    setBusy(btn, false, 'Transcribe File');
  }
}

function finishAnalysis(data) {
  currentVideoId = data.sessionId || data.videoId;
  currentVideoInfo = data.videoInfo;
  currentTranscript = data.transcript;
  currentSource = data.source || data.videoInfo?.source || 'youtube-captions';
  chatHistory = [];

  setupWorkspace(data);
  showView('workspace-view');
}

function setupWorkspace(data) {
  const info = data.videoInfo;
  const iframe = document.getElementById('video-iframe');
  const localVideo = document.getElementById('local-video');

  document.getElementById('video-title').textContent = info.title || 'Video';
  document.getElementById('video-channel').textContent =
    currentSource === 'upload'
      ? `${info.channel || 'Uploaded media'} • ${info.fileName || ''}`
      : info.channel || '';

  if (currentSource === 'upload') {
    iframe.style.display = 'none';
    localVideo.style.display = 'block';
    if (localVideoUrl) {
      localVideo.src = localVideoUrl;
      localVideo.load();
    }
    document.getElementById('source-badge').textContent = '🎙️ Uploaded media transcription';
  } else {
    localVideo.pause();
    localVideo.style.display = 'none';
    iframe.style.display = 'block';
    iframe.src = `${info.embedUrl}?rel=0&modestbranding=1`;
    document.getElementById('source-badge').textContent = '▶️ YouTube captions';
  }

  renderTranscript(data.transcript || []);
  resetChat();
  document.getElementById('transcript-search').value = '';
}

function renderTranscript(transcript) {
  const list = document.getElementById('transcript-list');
  list.innerHTML = '';

  if (!transcript.length) {
    list.innerHTML = '<div class="empty-state">No transcript segments found.</div>';
    return;
  }

  for (const seg of transcript) {
    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.dataset.text = String(seg.text || '').toLowerCase();

    const ts = document.createElement('span');
    ts.className = 'transcript-timestamp';
    ts.textContent = seg.timestamp;

    const text = document.createElement('span');
    text.className = 'transcript-text';
    text.textContent = seg.text;

    ts.addEventListener('click', e => {
      e.stopPropagation();
      seekTo(seg.start);
    });

    item.addEventListener('click', () => seekTo(seg.start));

    item.appendChild(ts);
    item.appendChild(text);
    list.appendChild(item);
  }
}

function filterTranscript() {
  const query = document.getElementById('transcript-search').value.toLowerCase().trim();
  document.querySelectorAll('.transcript-item').forEach(item => {
    item.style.display = !query || item.dataset.text.includes(query) ? '' : 'none';
  });
}

function seekTo(seconds) {
  if (!currentVideoId) return;

  const cleanSeconds = Math.max(0, Math.floor(Number(seconds) || 0));

  if (currentSource === 'upload') {
    const localVideo = document.getElementById('local-video');
    if (localVideo && Number.isFinite(localVideo.duration)) {
      localVideo.currentTime = Math.min(cleanSeconds, localVideo.duration || cleanSeconds);
      localVideo.play().catch(() => {});
    }
  } else {
    const iframe = document.getElementById('video-iframe');
    iframe.src =
      `https://www.youtube.com/embed/${currentVideoId}?start=${cleanSeconds}&autoplay=1&rel=0&modestbranding=1`;
  }

  showToast(`Jumped to ${formatTimestamp(cleanSeconds)}`);
}

function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function resetChat() {
  document.getElementById('chat-messages').innerHTML = `
    <div class="chat-welcome">
      <div class="chat-welcome-icon">🤖</div>
      <h4>Ask me anything about this video</h4>
      <p>Try a concept, a timestamp question, or ask for examples.</p>
      <div class="chat-suggestions">
        <button class="suggestion-chip" data-question="What are the most important concepts?">What are the most important concepts?</button>
      </div>
    </div>
  `;

  document.querySelectorAll('.suggestion-chip').forEach(btn => {
    btn.addEventListener('click', () => askSuggestion(btn.dataset.question));
  });
}

function clearChat() {
  chatHistory = [];
  resetChat();
  showToast('Conversation cleared');
}

function askSuggestion(question) {
  document.getElementById('chat-input').value = question;
  sendMessage();
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || isProcessing) return;

  if (!currentVideoId) {
    showToast('Analyze a video first.');
    return;
  }

  isProcessing = true;
  input.value = '';
  autoResize(input);

  const welcome = document.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  addMessage('user', message);
  chatHistory.push({ role: 'user', content: message });

  const loadingEl = showTypingIndicator();

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: currentVideoId,
        question: message,
        history: chatHistory.slice(-11)
      })
    });

    const data = await safeJson(resp);
    loadingEl.remove();

    if (!resp.ok) throw new Error(data.error || 'Failed to get answer.');

    addMessage('ai', data.answer || 'No answer returned.', data.relevantTimestamps || []);
    chatHistory.push({ role: 'assistant', content: data.answer || '' });
  } catch (err) {
    loadingEl.remove();
    addMessage('ai', `Sorry, I encountered an error: ${err.message}`);
  } finally {
    isProcessing = false;
    scrollToBottom();
  }
}

function addMessage(role, content) {
  const messages = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = `chat-message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = role === 'user' ? 'You' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  if (role === 'ai') {
    bubble.innerHTML = renderMarkdown(content);
    makeTimestampsClickable(bubble);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = '📋 Copy';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(content);
        showToast('Copied to clipboard');
      } catch {
        showToast('Copy failed');
      }
    };
    actions.appendChild(copyBtn);
    bubble.appendChild(actions);
  } else {
    bubble.textContent = content;
  }

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  messages.appendChild(msg);
  scrollToBottom();
}

function showTypingIndicator() {
  const messages = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-loading';
  el.innerHTML = `
    <div class="chat-avatar">AI</div>
    <div class="typing-dots"><span></span><span></span><span></span></div>
  `;
  messages.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  const messages = document.getElementById('chat-messages');
  messages.scrollTop = messages.scrollHeight;
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    try {
      marked.setOptions({ breaks: true, gfm: true });
      return marked.parse(String(text || ''));
    } catch {}
  }
  return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
}

function makeTimestampsClickable(container) {
  const tsRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (tsRegex.test(node.nodeValue)) nodes.push(node);
    tsRegex.lastIndex = 0;
  }

  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    const text = node.nodeValue;
    let lastIndex = 0;
    tsRegex.lastIndex = 0;
    let match;

    while ((match = tsRegex.exec(text))) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'ts-link';
      link.textContent = match[1];
      link.addEventListener('click', () => seekTo(parseTimestamp(match[1])));
      fragment.appendChild(link);
      lastIndex = tsRegex.lastIndex;
    }

    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(fragment);
  }
}

function parseTimestamp(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function generateSummary(type) {
  if (!currentVideoId) return;

  const titles = {
    quick: 'Summary',
    detailed: 'Detailed Summary',
    keypoints: 'Key Points'
  };

  showOutputPanel(titles[type] || 'Summary', '<div class="loading-inline">Generating...</div>');

  try {
    const resp = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: currentVideoId, type })
    });
    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data.error || 'Summary failed.');

    const body = document.getElementById('output-content');
    body.innerHTML = renderMarkdown(data.summary);
    makeTimestampsClickable(body);
  } catch (err) {
    renderOutputError(err);
  }
}

function showOutputPanel(title, content) {
  document.getElementById('output-title').textContent = title;
  document.getElementById('output-content').innerHTML = content;
  document.getElementById('output-panel').classList.add('show');
}

function closeOutputPanel() {
  document.getElementById('output-panel')?.classList.remove('show');
}

async function copyOutput() {
  try {
    await navigator.clipboard.writeText(document.getElementById('output-content').innerText);
    showToast('Copied to clipboard');
  } catch {
    showToast('Copy failed');
  }
}

function renderOutputError(err) {
  document.getElementById('output-content').innerHTML =
    `<p style="color:var(--error-500)">Error: ${escapeHtml(err.message)}</p>`;
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function setBusy(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  const span = button.querySelector('.btn-text');
  if (span) span.textContent = text;
}

function showInputError(message) {
  const errorEl = document.getElementById('url-error');
  errorEl.textContent = message;
  errorEl.classList.add('show');
}

async function safeJson(resp) {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return await resp.json();
  const text = await resp.text();
  return { error: text || `Request failed with HTTP ${resp.status}` };
}

function updateLoadingText(text, subtext) {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading-subtext').textContent = subtext || '';
}

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('url-input');
  const chatInput = document.getElementById('chat-input');

  urlInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') analyzeVideo();
  });

  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInput.addEventListener('input', () => autoResize(chatInput));


  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeOutputPanel();
    }
  });
});
