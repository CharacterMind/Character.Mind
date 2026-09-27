// ── State ─────────────────────────────────────────────────────────────────────
let apiKey = localStorage.getItem('cm_apiKey') || '';
let characters = [];
let currentChar = null;
let isStreaming = false;
let currentFilter = 'all';
let lastUserMessage = '';

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  if (apiKey) {
    document.getElementById('apiModal').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    await loadCharacters();
    renderHome();
    renderDiscover();
    renderFeed();
  } else {
    document.getElementById('apiModal').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
});

async function loadCharacters() {
  const res = await fetch('/api/characters');
  characters = await res.json();
  const custom = JSON.parse(localStorage.getItem('cm_custom') || '[]');
  characters = [...characters, ...custom];
  renderSidebarChats();
}

// ── API Key ───────────────────────────────────────────────────────────────────
function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (key.length < 10) { alert('Please enter a valid Google Gemini API key'); return; }
  apiKey = key;
  localStorage.setItem('cm_apiKey', key);
  document.getElementById('apiModal').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  loadCharacters().then(() => { renderHome(); renderDiscover(); renderFeed(); });
}

function changeApiKey() {
  document.getElementById('apiKeyInput').value = apiKey;
  document.getElementById('apiModal').style.display = 'flex';
}

function toggleApiVis() {
  const inp = document.getElementById('apiKeyInput');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('infoPanel').style.display = 'none';
}
function showHome() { showView('homeView'); setNavActive(0); }
function showDiscover() { showView('discoverView'); setNavActive(1); renderDiscover(); }
function showFeed() { showView('feedView'); setNavActive(2); }
function showCreate() { showView('createView'); setNavActive(3); }
function setNavActive(i) { document.querySelectorAll('.nav-item')[i]?.classList.add('active'); }

// ── Render Home — c.ai style rows ─────────────────────────────────────────────
function renderHome() {
  const grid = document.getElementById('charGrid');
  const banner = document.getElementById('featuredBanner');

  if (characters.length === 0) {
    banner.innerHTML = '';
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✦</div>
      <div class="empty-title">No characters yet</div>
      <div class="empty-sub">Hit <strong>Create</strong> to make your first one.</div>
      <button class="btn-primary" onclick="showCreate()" style="margin-top:16px">Create a character</button>
    </div>`;
    return;
  }

  banner.innerHTML = '';
  const label = document.getElementById('homeGridLabel');
  if (label) label.textContent = '';
  grid.innerHTML = `<div class="char-list">${characters.map(c => charRow(c)).join('')}</div>`;
}

function avatarHtml(c, cls) {
  if (c.image) return `<div class="${cls}" style="background:#111"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"></div>`;
  return `<div class="${cls}" style="background:${c.color||'#7c3aed'}">${c.name[0]}</div>`;
}

function charRow(c) {
  const av = c.image
    ? `<div class="char-row-avatar" style="background:#111;overflow:hidden"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:10px"></div>`
    : `<div class="char-row-avatar" style="background:${c.color||'#7c3aed'}">${c.name[0]}</div>`;
  return `<div class="char-row" onclick="openChat('${c.id}')">
    ${av}
    <div class="char-row-info">
      <div class="char-row-name">${c.name}</div>
      <div class="char-row-tagline">${c.tagline || ''}</div>
      <div class="char-row-meta">${c.creator || '@you'} · ${formatCount(c.interactions||0)} chats</div>
    </div>
  </div>`;
}

function charCard(c) {
  return `<div class="char-card" onclick="openChat('${c.id}')">
    ${avatarHtml(c, 'card-avatar')}
    <div class="card-name">${c.name}</div>
    <div class="card-tagline">${c.tagline}</div>
    <div class="card-meta">
      <span class="card-creator">${c.creator || '@user'}</span>
      <span class="card-interactions">💬 ${formatCount(c.interactions||0)}</span>
    </div>
    <div class="card-tags">${(c.tags||[]).map(t=>`<span class="card-tag">${t}</span>`).join('')}</div>
  </div>`;
}

function formatCount(n) {
  n = parseInt(n) || 0;
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}

// ── Render Discover ───────────────────────────────────────────────────────────
function renderDiscover() {
  const grid = document.getElementById('discoverGrid');
  const filtered = currentFilter === 'all' ? characters : characters.filter(c => (c.tags||[]).includes(currentFilter));
  grid.innerHTML = filtered.map(c => charCard(c)).join('');
}

function setFilter(btn, tag) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = tag;
  renderDiscover();
}

// ── Render Feed ───────────────────────────────────────────────────────────────
function renderFeed() {
  const feedList = document.getElementById('feedList');
  if (characters.length === 0) {
    feedList.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><div class="empty-title">Nothing here yet</div><div class="empty-sub">Create some characters first.</div></div>`;
    return;
  }
  feedList.innerHTML = characters.map(c => {
    const av = c.image
      ? `<div class="feed-avatar" style="background:#111;overflow:hidden"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover"></div>`
      : `<div class="feed-avatar" style="background:${c.color||'#7c3aed'}">${c.name[0]}</div>`;
    return `<div class="feed-card">
      <div class="feed-card-header">
        ${av}
        <div><div class="feed-char-name">${c.name}</div><div class="feed-char-sub">${c.creator||'@you'} · ${formatCount(c.interactions||0)} chats</div></div>
      </div>
      <div class="feed-preview">${c.description || c.tagline || ''}</div>
      <div class="feed-footer">
        <span class="feed-likes">💬 ${formatCount(c.interactions||0)}</span>
        <button class="btn-chat-feed" onclick="openChat('${c.id}')">Chat</button>
      </div>
    </div>`;
  }).join('');
}

// ── Render Sidebar ─────────────────────────────────────────────────────────────
function renderSidebarChats() {
  const list = document.getElementById('recentList');
  if (characters.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = characters.slice(0,10).map(c => `
    <div class="chat-item ${currentChar?.id===c.id?'active':''}" onclick="openChat('${c.id}')">
      ${avatarHtml(c, 'chat-item-avatar')}
      <div class="chat-item-info">
        <div class="chat-item-name">${c.name}</div>
      </div>
    </div>`).join('');
}

function filterChats(q) {
  const items = document.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = item.querySelector('.chat-item-name').textContent.toLowerCase();
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ── Open Chat ─────────────────────────────────────────────────────────────────
async function openChat(charId) {
  currentChar = characters.find(c => c.id === charId);
  if (!currentChar) return;

  showView('chatView');
  document.getElementById('chatView').classList.remove('hidden');
  document.getElementById('infoPanel').style.display = 'flex';

  // Update info panel
  const ia = document.getElementById('infoAvatar');
  if (currentChar.image) { ia.style.background = '#111'; ia.style.borderRadius = '12px'; ia.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`; }
  else { ia.style.background = currentChar.color; ia.style.borderRadius = '12px'; ia.textContent = currentChar.name[0]; }
  document.getElementById('infoName').textContent = currentChar.name;
  document.getElementById('infoCreator').textContent = currentChar.creator || '@you';
  document.getElementById('infoInteractions').textContent = formatCount(currentChar.interactions||0);
  document.getElementById('infoDesc').textContent = currentChar.description || currentChar.tagline || '';
  document.getElementById('infoTags').innerHTML = (currentChar.tags||[]).map(t=>`<span class="card-tag">${t}</span>`).join('');

  // Update typing indicator
  updateTypingAvatar();

  // Load conversation history
  const res = await fetch(`/api/conversations/${charId}`);
  const history = await res.json();

  const messagesDiv = document.getElementById('messages');
  messagesDiv.innerHTML = '';

  if (history.length === 0) {
    document.getElementById('chatWelcome').innerHTML = '';
    if (currentChar.greeting) {
      appendMessage('ai', currentChar.greeting);
    } else {
      document.getElementById('chatWelcome').innerHTML = `
        <div class="chat-welcome-name">${currentChar.name}</div>
        <div>${currentChar.tagline || ''}</div>`;
    }
  } else {
    document.getElementById('chatWelcome').innerHTML = '';
    history.forEach(m => appendMessage(m.role === 'user' ? 'user' : 'ai', m.content));
  }

  renderSidebarChats();
  document.getElementById('messageInput').focus();
  scrollToBottom();
}

function updateTypingAvatar() {
  if (!currentChar) return;
  const ta = document.getElementById('typingAvatar');
  const tn = document.getElementById('typingName');
  if (currentChar.image) { ta.style.background = '#111'; ta.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; }
  else { ta.style.background = currentChar.color; ta.textContent = currentChar.name[0]; }
  if (tn) tn.textContent = currentChar.name;
  const inp = document.getElementById('messageInput');
  if (inp) inp.placeholder = `Message ${currentChar.name}…`;
}

// ── Send Message ──────────────────────────────────────────────────────────────
async function sendMessage() {
  if (isStreaming || !currentChar) return;
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text) return;

  lastUserMessage = text;
  input.value = '';
  autoResize(input);
  appendMessage('user', text);
  document.getElementById('chatWelcome').innerHTML = '';
  scrollToBottom();

  showTyping(true);
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ charId: currentChar.id, message: text, apiKey, systemPrompt: currentChar.systemPrompt })
    });

    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Server error'); }

    let msgEl = null, bubble = null, gotFirst = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.text) {
          if (!gotFirst) {
            gotFirst = true;
            showTyping(false);
            msgEl = createAiMessage();
            bubble = msgEl.querySelector('.bubble');
            bubble.classList.add('streaming');
          }
          streamText += data.text;
          bubble.innerHTML = renderMarkdown(streamText);
          scrollToBottom();
        }
      }
    }
    if (bubble) bubble.classList.remove('streaming');
  } catch (err) {
    showTyping(false);
    document.querySelectorAll('.bubble.streaming').forEach(b => b.classList.remove('streaming'));
    appendMessage('ai', `⚠️ ${err.message}`);
  } finally {
    isStreaming = false;
    document.getElementById('sendBtn').disabled = false;
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ── Message Rendering — c.ai style ───────────────────────────────────────────
function msgAvatarHtml(cls) {
  if (!currentChar) return `<div class="${cls}" style="background:#555">A</div>`;
  if (currentChar.image) return `<div class="${cls}" style="background:#111;overflow:hidden"><img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"></div>`;
  return `<div class="${cls}" style="background:${currentChar.color||'#666'}">${currentChar.name[0]}</div>`;
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (role === 'ai') {
    div.innerHTML = `
      <div class="msg-header">
        ${msgAvatarHtml('msg-avatar')}
        <span class="msg-name">${currentChar?.name || 'AI'}</span>
        <span class="msg-badge">CM</span>
      </div>
      <div class="bubble">${renderMarkdown(text)}</div>
      <div class="msg-footer">
        ${regenBtn()}${likeBtn()}${dislikeBtn()}
      </div>`;
  } else {
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:var(--text3)">You</span>
      </div>
      <div class="bubble">${escHtml(text)}</div>`;
  }
  document.getElementById('messages').appendChild(div);
  return div;
}

function createAiMessage() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="msg-header">
      ${msgAvatarHtml('msg-avatar')}
      <span class="msg-name">${currentChar?.name || 'AI'}</span>
      <span class="msg-badge">CM</span>
    </div>
    <div class="bubble"></div>
    <div class="msg-footer">
      ${regenBtn()}${likeBtn()}${dislikeBtn()}
    </div>`;
  document.getElementById('messages').appendChild(div);
  return div;
}

function regenBtn() {
  return `<button class="reaction-btn regen-btn" onclick="regenerate()" title="Regenerate"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4C7.58 4 4 7.58 4 12s3.58 8 8 8 8-3.58 8-8h-2c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>`;
}
function likeBtn() {
  return `<button class="reaction-btn like-btn" onclick="toggleLike(this)" title="Like"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg></button>`;
}
function dislikeBtn() {
  return `<button class="reaction-btn dislike-btn" onclick="toggleDislike(this)" title="Dislike"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L10.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg></button>`;
}

function toggleLike(btn) {
  const wasActive = btn.classList.contains('active');
  btn.closest('.msg-footer').querySelector('.dislike-btn')?.classList.remove('active');
  btn.classList.toggle('active', !wasActive);
  if (!wasActive) { btn.style.transform = 'scale(1.35)'; setTimeout(() => { btn.style.transform = ''; }, 180); }
}

function toggleDislike(btn) {
  if (btn.classList.contains('active')) { btn.classList.remove('active'); return; }
  btn.classList.add('active');
  btn.closest('.msg-footer').querySelector('.like-btn')?.classList.remove('active');
  btn.style.transform = 'scale(1.35)';
  setTimeout(() => { btn.style.transform = ''; }, 180);
  setTimeout(() => regenerate(), 500);
}

// ── Regenerate ─────────────────────────────────────────────────────────────────
async function regenerate() {
  if (isStreaming || !currentChar) return;
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  const messagesDiv = document.getElementById('messages');
  const allMsgs = [...messagesDiv.querySelectorAll('.msg.ai')];
  if (allMsgs.length > 0) allMsgs[allMsgs.length - 1].remove();

  showTyping(true);

  let msgEl = null, bubble = null, gotFirstChunk = false;

  try {
    const res = await fetch(`/api/regenerate/${currentChar.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, systemPrompt: currentChar.systemPrompt })
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Server error'); }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.text) {
          if (!gotFirstChunk) {
            gotFirstChunk = true;
            showTyping(false);
            msgEl = createAiMessage();
            bubble = msgEl.querySelector('.bubble');
            bubble.classList.add('streaming');
          }
          streamText += data.text;
          bubble.innerHTML = renderMarkdown(streamText);
          scrollToBottom();
        }
      }
    }
    if (bubble) bubble.classList.remove('streaming');
  } catch (err) {
    showTyping(false);
    if (bubble) { bubble.classList.remove('streaming'); bubble.innerHTML = `<p>⚠️ ${escHtml(err.message)}</p>`; }
    else appendMessage('ai', `⚠️ ${err.message}`);
  } finally {
    showTyping(false);
    isStreaming = false;
    document.getElementById('sendBtn').disabled = false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderMarkdown(text) {
  let s = escHtml(text);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  const paras = s.split(/\n\n+/);
  return paras.map(p => p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '').filter(Boolean).join('');
}

function showTyping(v) {
  document.getElementById('typingIndicator').classList.toggle('hidden', !v);
  if (v) scrollToBottom();
}

function scrollToBottom() {
  const body = document.getElementById('chatBody');
  body.scrollTop = body.scrollHeight;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function newChat() {
  if (!currentChar) return;
  fetch(`/api/conversations/${currentChar.id}`, { method: 'DELETE' });
  document.getElementById('messages').innerHTML = '';
  document.getElementById('chatWelcome').innerHTML = `
    <div class="chat-welcome-name">${currentChar.name}</div>
    <div>${currentChar.tagline || ''}</div>`;
}

function toggleInfoPanel() {
  const panel = document.getElementById('infoPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function editCurrentChar() {
  if (!currentChar) return;
  const c = currentChar;
  showCreate();
  document.getElementById('newName').value = c.name; updateCount('newName','nameCount',20);
  document.getElementById('newTagline').value = c.tagline || ''; updateCount('newTagline','taglineCount',50);
  document.getElementById('newDesc').value = c.description || ''; updateCount('newDesc','descCount',500);
  document.getElementById('newGreeting').value = c.greeting || ''; updateCount('newGreeting','greetingCount',4096);
  document.getElementById('newPrompt').value = c.systemPrompt || '';
  document.getElementById('newColor').value = c.color || '#7c3aed';
  if (c.image) { pendingAvatarData = c.image; document.getElementById('avatarPreview').innerHTML = `<img src="${c.image}" alt="avatar">`; }
  document.getElementById('newName').dataset.editingId = c.id;
  document.querySelector('.btn-submit').textContent = 'Save Changes';
}

function deleteCurrentChar() {
  if (!currentChar) return;
  if (!confirm(`Delete ${currentChar.name}? This can't be undone.`)) return;
  const custom = JSON.parse(localStorage.getItem('cm_custom') || '[]');
  const updated = custom.filter(c => c.id !== currentChar.id);
  localStorage.setItem('cm_custom', JSON.stringify(updated));
  characters = characters.filter(c => c.id !== currentChar.id);
  currentChar = null;
  renderHome(); renderDiscover(); renderFeed(); renderSidebarChats();
  showHome();
}

// ── Create Character ───────────────────────────────────────────────────────────
let pendingAvatarData = null;

function updateCount(fieldId, countId, max) {
  const val = document.getElementById(fieldId)?.value.length || 0;
  const el = document.getElementById(countId);
  if (el) el.textContent = val;
}

// ── Avatar Crop ────────────────────────────────────────────────────────────────
const crop = { scale: 1, ox: 0, oy: 0, imgW: 0, imgH: 0, dragging: false, lx: 0, ly: 0, ready: false };

function previewAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => openCropModal(ev.target.result);
  reader.readAsDataURL(file);
}

function openCropModal(dataUrl) {
  const img = document.getElementById('cropImg');
  img.onload = () => {
    document.getElementById('cropModal').style.display = 'flex';
    const c = document.getElementById('cropContainer');
    const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
    crop.imgW = img.naturalWidth; crop.imgH = img.naturalHeight;
    const fit = Math.max(cw / crop.imgW, ch / crop.imgH);
    crop.scale = fit; crop.ox = (cw - crop.imgW * fit) / 2; crop.oy = (ch - crop.imgH * fit) / 2;
    const sl = document.getElementById('zoomSlider');
    sl.min = fit * 0.25; sl.max = fit * 10; sl.value = fit;
    applyCropTransform();
    if (!crop.ready) { initCropEvents(); crop.ready = true; }
  };
  img.src = dataUrl;
}

function closeCropModal() {
  document.getElementById('cropModal').style.display = 'none';
  document.getElementById('avatarUpload').value = '';
}

function applyCropTransform() {
  const img = document.getElementById('cropImg');
  img.style.left = crop.ox + 'px'; img.style.top = crop.oy + 'px';
  img.style.width = (crop.imgW * crop.scale) + 'px'; img.style.height = (crop.imgH * crop.scale) + 'px';
}

function adjustZoom(delta) {
  const c = document.getElementById('cropContainer');
  const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
  const newScale = Math.max(parseFloat(document.getElementById('zoomSlider').min),
                            Math.min(parseFloat(document.getElementById('zoomSlider').max),
                                     crop.scale * (1 + delta)));
  const ratio = newScale / crop.scale;
  crop.ox = cw/2 + (crop.ox - cw/2) * ratio; crop.oy = ch/2 + (crop.oy - ch/2) * ratio;
  crop.scale = newScale; document.getElementById('zoomSlider').value = newScale;
  applyCropTransform();
}

function setZoomFromSlider(val) {
  const newScale = parseFloat(val), ratio = newScale / crop.scale;
  const c = document.getElementById('cropContainer');
  const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
  crop.ox = cw/2 + (crop.ox - cw/2) * ratio; crop.oy = ch/2 + (crop.oy - ch/2) * ratio;
  crop.scale = newScale; applyCropTransform();
}

function confirmCrop() {
  const size = 400;
  const c = document.getElementById('cropContainer');
  const cw = c.clientWidth || 360;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  const s = size / cw;
  ctx.drawImage(document.getElementById('cropImg'), crop.ox*s, crop.oy*s, crop.imgW*crop.scale*s, crop.imgH*crop.scale*s);
  pendingAvatarData = canvas.toDataURL('image/jpeg', 0.92);
  document.getElementById('avatarPreview').innerHTML = `<img src="${pendingAvatarData}" alt="avatar">`;
  document.getElementById('cropModal').style.display = 'none';
}

function initCropEvents() {
  const c = document.getElementById('cropContainer');
  c.addEventListener('mousedown', e => { crop.dragging = true; crop.lx = e.clientX; crop.ly = e.clientY; c.style.cursor = 'grabbing'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!crop.dragging) return; crop.ox += e.clientX - crop.lx; crop.oy += e.clientY - crop.ly; crop.lx = e.clientX; crop.ly = e.clientY; applyCropTransform(); });
  document.addEventListener('mouseup', () => { crop.dragging = false; c.style.cursor = 'grab'; });
  c.addEventListener('touchstart', e => { if (e.touches.length === 1) { crop.dragging = true; crop.lx = e.touches[0].clientX; crop.ly = e.touches[0].clientY; } e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (crop.dragging && e.touches.length === 1) { crop.ox += e.touches[0].clientX - crop.lx; crop.oy += e.touches[0].clientY - crop.ly; crop.lx = e.touches[0].clientX; crop.ly = e.touches[0].clientY; applyCropTransform(); } });
  document.addEventListener('touchend', () => { crop.dragging = false; });
  let lastPinch = 0;
  c.addEventListener('touchstart', e => { if (e.touches.length === 2) { crop.dragging = false; lastPinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); } });
  c.addEventListener('touchmove', e => { if (e.touches.length === 2) { e.preventDefault(); const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (lastPinch) adjustZoom((d - lastPinch) / lastPinch * 0.8); lastPinch = d; } }, { passive: false });
  c.addEventListener('touchend', () => { lastPinch = 0; });
  c.addEventListener('wheel', e => { e.preventDefault(); adjustZoom(e.deltaY < 0 ? 0.08 : -0.08); }, { passive: false });
}

function setStyle(v) { /* style modifier — future: adjust system prompt tone */ }
function showHistory() {}

function createCharacter(e) {
  e.preventDefault();
  const name = document.getElementById('newName').value.trim();
  const tagline = document.getElementById('newTagline').value.trim();
  const desc = document.getElementById('newDesc').value.trim();
  const greeting = document.getElementById('newGreeting').value.trim();
  const prompt = document.getElementById('newPrompt').value.trim();
  const color = document.getElementById('newColor').value;
  const editingId = document.getElementById('newName').dataset.editingId;
  const id = editingId || 'custom_' + Date.now();

  const char = {
    id, name, tagline, creator: '@you',
    interactions: editingId ? (characters.find(c=>c.id===editingId)?.interactions || '0') : '0',
    avatar: id, color, accentColor: color, tags: ['Custom'], description: desc,
    image: pendingAvatarData || (editingId ? characters.find(c=>c.id===editingId)?.image : null) || null,
    greeting: greeting || null,
    systemPrompt: prompt || `You are ${name}. ${desc}`
  };

  const custom = JSON.parse(localStorage.getItem('cm_custom') || '[]');
  if (editingId) {
    const idx = custom.findIndex(c => c.id === editingId);
    if (idx >= 0) custom[idx] = char; else custom.push(char);
    characters = characters.map(c => c.id === editingId ? char : c);
  } else {
    custom.push(char); characters.push(char);
  }
  localStorage.setItem('cm_custom', JSON.stringify(custom));

  e.target.reset();
  pendingAvatarData = null;
  document.getElementById('newName').dataset.editingId = '';
  document.querySelector('.btn-submit').textContent = 'Create Character';
  document.getElementById('avatarPreview').innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;opacity:0.3"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
  ['nameCount','taglineCount','descCount','greetingCount'].forEach(id => { const el = document.getElementById(id); if(el) el.textContent = '0'; });

  renderSidebarChats(); renderHome(); renderDiscover();
  openChat(id);
}
