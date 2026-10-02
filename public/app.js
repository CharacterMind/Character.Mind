// ── State ─────────────────────────────────────────────────────────────────────
let knownTemplateAliases = [];
let templatesLoaded = false;
let currentUser = null;
let characters = [];
let currentChar = null;
let isStreaming = false;
let currentFilter = 'all';
let lastUserMessage = '';
// ── Model & Effort state ───────────────────────────────────────────────────────
const EFFORT_LEVELS = ['low','medium','high'];
let selectedModelTier = (() => {
  try {
    const s = localStorage.getItem('cm_model_tier') || 'opas';
    // Migrate old tier names
    const migrate = { standard:'opas', flash:'opas', pro:'opes', ultra:'opes' };
    return (s === 'opas' || s === 'opes') ? s : (migrate[s] || 'opas');
  } catch(_){ return 'opas'; }
})();
let selectedEffort = (() => {
  try {
    const s = localStorage.getItem('cm_effort') || 'medium';
    // Migrate old effort values
    const migrate = { quick:'low', standard:'medium', deep:'high', extra:'high', max:'high' };
    return EFFORT_LEVELS.includes(s) ? s : (migrate[s] || 'medium');
  } catch(_){ return 'medium'; }
})();

const MODEL_LABELS  = { opas:'Opas', opes:'Opes' };
const EFFORT_LABELS = { low:'Low', medium:'Medium', high:'High' };

const MODEL_ICONS = {
  opas: '<path d="M7 2v11h3v9l7-12h-4l4-8z"/>',
  opes: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
};

function updateModelBarLabel() {
  const modelEl = document.getElementById('mbModelLabel');
  if (modelEl) modelEl.textContent = MODEL_LABELS[selectedModelTier] || selectedModelTier;
  const effortEl = document.getElementById('mbEffortLabel');
  if (effortEl) effortEl.textContent = EFFORT_LABELS[selectedEffort] || selectedEffort;
  const icon = document.getElementById('modelBarIcon');
  if (icon) icon.innerHTML = MODEL_ICONS[selectedModelTier] || MODEL_ICONS.opas;
  ['optOpas','optOpes'].forEach(id => document.getElementById(id)?.classList.remove('active'));
  const modelId = { opas:'optOpas', opes:'optOpes' }[selectedModelTier];
  if (modelId) document.getElementById(modelId)?.classList.add('active');
  const idx = EFFORT_LEVELS.indexOf(selectedEffort);
  const rangeEl = document.getElementById('effortRange');
  if (rangeEl) rangeEl.value = idx;
  const lbl = document.getElementById('eppCurrentLabel');
  if (lbl) lbl.textContent = EFFORT_LABELS[selectedEffort] || selectedEffort;
}

function setModelTier(tier) {
  selectedModelTier = tier;
  try { localStorage.setItem('cm_model_tier', tier); } catch(_) {}
  updateModelBarLabel();
  closeAllPickers();
}

function setEffort(effort) {
  selectedEffort = effort;
  try { localStorage.setItem('cm_effort', effort); } catch(_) {}
  updateModelBarLabel();
}

function setEffortIdx(idx) {
  setEffort(EFFORT_LEVELS[idx] || 'medium');
}

let modelDropdownOpen = false;
let effortPanelOpen = false;
function closeAllPickers() {
  modelDropdownOpen = false;
  effortPanelOpen = false;
  const md = document.getElementById('modelDropdown');
  const ep = document.getElementById('effortPanelPopup');
  if (md) md.style.display = 'none';
  if (ep) ep.style.display = 'none';
}
function toggleModelDropdown() {
  const wasOpen = modelDropdownOpen;
  closeAllPickers();
  if (!wasOpen) {
    modelDropdownOpen = true;
    const md = document.getElementById('modelDropdown');
    if (md) md.style.display = 'block';
  }
}
function toggleEffortPanel() {
  const wasOpen = effortPanelOpen;
  closeAllPickers();
  if (!wasOpen) {
    effortPanelOpen = true;
    const ep = document.getElementById('effortPanelPopup');
    if (ep) ep.style.display = 'block';
  }
}

// Close pickers when clicking outside
document.addEventListener('click', (e) => {
  if ((modelDropdownOpen || effortPanelOpen)
    && !e.target.closest('#modelDropdown')
    && !e.target.closest('#effortPanelPopup')
    && !e.target.closest('#mbModelBtn')
    && !e.target.closest('#mbEffortBtn')) {
    closeAllPickers();
  }
});

// Keyboard shortcuts: 1 = Opas, 2 = Opes (when model dropdown open)
document.addEventListener('keydown', (e) => {
  if (modelDropdownOpen && !e.target.matches('input,textarea')) {
    if (e.key === '1') setModelTier('opas');
    if (e.key === '2') setModelTier('opes');
  }
});

// ── New Chat Warning ───────────────────────────────────────────────────────────
function requestNewChat() {
  if (!currentChar) return;
  closeSidebarMobile();
  document.getElementById('newChatWarningModal').style.display = 'flex';
}
function closeNewChatWarning() {
  document.getElementById('newChatWarningModal').style.display = 'none';
}
async function confirmNewChat() {
  closeNewChatWarning();
  await newChat();
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  loadColorblindMode();
  initGradientPicker('#7c3aed');
  const gcHex = document.getElementById('gcHexInput');
  if (gcHex) {
    gcHex.addEventListener('input', () => _gcApplyHex(gcHex.value));
    gcHex.addEventListener('paste', () => setTimeout(() => _gcApplyHex(gcHex.value), 0));
  }
  updateModelBarLabel();
  fetch('/api/templates').then(r => r.json()).then(tpls => {
    knownTemplateAliases = tpls.flatMap(t => t.aliases.map(a => a.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim()));
    templatesLoaded = true;
    checkTemplateName();
  }).catch(() => { templatesLoaded = true; });
  checkSeasonalEvent();
  try {
    const r = await fetch('/auth/me');
    currentUser = await r.json();
    window.currentUser = currentUser;
  } catch (_) { currentUser = null; }

  document.getElementById('appLoading').style.display = 'none';

  if (currentUser) {
    document.getElementById('authLanding').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    renderUserBadge();
    await loadCharacters();
    renderHome();
    renderDiscover();
    renderFeed();
    loadUsage();
    maybeShowWelcome();
    initSidebarState();
    updateModelBarLabel();
  } else {
    document.getElementById('authLanding').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    // Show error toast if auth failed or isn't configured yet
    const authParam = new URLSearchParams(window.location.search).get('auth');
    if (authParam === 'fail') showWarning('Sign-in failed. Please try again.');
    if (authParam === 'unavailable') showWarning('Google sign-in is not set up yet. Check back soon!');
    if (authParam) history.replaceState({}, '', '/');
  }
});

async function loadCharacters() {
  try {
    const res = await fetch('/api/characters');
    if (res.status === 401) { characters = []; renderSidebarChats(); return; }
    characters = await res.json();
  } catch {
    characters = [];
  }
  renderSidebarChats();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function getCustomPfp() {
  if (!currentUser) return null;
  try { return localStorage.getItem(`cm_pfp_${currentUser.googleId}`) || null; } catch { return null; }
}

function getDisplayName() {
  if (!currentUser) return '';
  try { return localStorage.getItem(`cm_name_${currentUser.googleId}`) || currentUser.name || ''; } catch { return currentUser.name || ''; }
}

function getDisplayEmail() {
  if (!currentUser) return '';
  try { return localStorage.getItem(`cm_email_${currentUser.googleId}`) || currentUser.email || ''; } catch { return currentUser.email || ''; }
}

function settingsFieldDirty(field) {
  const btn = document.getElementById(field === 'name' ? 'settingsNameSave' : 'settingsEmailSave');
  if (btn) btn.style.display = 'inline-flex';
}

// Curated colorblind-safe palettes — colors that are maximally distinguishable
// for each vision type, completely replacing the normal color picker options
const CB_PALETTES = {
  protanopia: {
    label: 'Red-weak safe palette',
    // Blues, yellows, purples — red & green look identical to protanopes
    colors: ['#0ea5e9','#1d4ed8','#eab308','#f97316','#7c3aed','#06b6d4','#facc15','#a78bfa'],
    defaults: ['#0ea5e9','#eab308']
  },
  deuteranopia: {
    label: 'Green-weak safe palette',
    // Blues, oranges, purples — green & red look identical to deuteranopes
    colors: ['#0ea5e9','#1d4ed8','#f97316','#fb923c','#7c3aed','#06b6d4','#facc15','#c084fc'],
    defaults: ['#0ea5e9','#f97316']
  },
  tritanopia: {
    label: 'Blue-yellow safe palette',
    // Reds, greens, magentas — blue & yellow are indistinguishable to tritanopes
    colors: ['#ef4444','#dc2626','#22c55e','#16a34a','#ec4899','#db2777','#f43f5e','#4ade80'],
    defaults: ['#ef4444','#22c55e']
  },
  achromatopsia: {
    label: 'High-contrast grayscale',
    // Only luminance — no hue is visible, only brightness difference matters
    colors: ['#ffffff','#d4d4d4','#a3a3a3','#737373','#404040','#1a1a1a','#e5e5e5','#525252'],
    defaults: ['#d4d4d4','#525252']
  }
};

function _applyGCPalette(mode) {
  const container = document.getElementById('gradientSwatches');
  const colorRow = document.getElementById('gcColorRow');
  const achroNote = document.getElementById('gcAchroNote');
  const strip = document.getElementById('gcPaletteStrip');

  // Achromatopsia — hide the whole picker, show a note instead
  if (mode === 'achromatopsia') {
    if (colorRow) colorRow.style.display = 'none';
    if (strip) strip.style.display = 'none';
    if (achroNote) achroNote.style.display = 'flex';
    return;
  }

  // All other modes — show the picker
  if (colorRow) colorRow.style.display = '';
  if (achroNote) achroNote.style.display = 'none';
  if (!container) return;

  const palette = CB_PALETTES[mode];
  container.innerHTML = '';
  const startColors = palette ? palette.defaults : ['#7c3aed'];
  startColors.forEach(c => addGradientSwatch(c));
  updateGradientPreview();

  if (!strip) return;
  if (!palette) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = '';
  const lbl = document.createElement('span');
  lbl.className = 'gc-palette-label';
  lbl.textContent = palette.label + ':';
  strip.appendChild(lbl);
  palette.colors.forEach(hex => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gc-palette-chip';
    chip.style.background = hex;
    chip.title = hex;
    chip.setAttribute('aria-label', 'Use color ' + hex);
    chip.addEventListener('click', () => {
      const sw = container.querySelector('.gc-swatch-input');
      if (sw) { sw.value = hex; updateGradientPreview(); }
      strip.querySelectorAll('.gc-palette-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
    strip.appendChild(chip);
  });
}

function setColorblindMode(mode) {
  try { localStorage.setItem('cm_colorblind', mode || ''); } catch(_) {}
  if (mode) {
    document.documentElement.dataset.colorblind = mode;
  } else {
    delete document.documentElement.dataset.colorblind;
  }
  const v = mode || '';
  const s1 = document.getElementById('colorblindMode');
  const s2 = document.getElementById('gcColorblindPicker');
  if (s1) s1.value = v;
  if (s2) s2.value = v;
  _applyGCPalette(mode);
}

function loadColorblindMode() {
  try {
    const mode = localStorage.getItem('cm_colorblind') || '';
    if (mode) document.documentElement.dataset.colorblind = mode;
    const s1 = document.getElementById('colorblindMode');
    const s2 = document.getElementById('gcColorblindPicker');
    if (s1) s1.value = mode;
    if (s2) s2.value = mode;
    if (mode) _applyGCPalette(mode);
  } catch(_) {}
}

function saveProfileField(field) {
  if (!currentUser) return;
  const input = document.getElementById(field === 'name' ? 'settingsNameInput' : 'settingsEmailInput');
  const btn   = document.getElementById(field === 'name' ? 'settingsNameSave'  : 'settingsEmailSave');
  if (!input) return;
  const val = input.value.trim();
  try {
    if (val) localStorage.setItem(`cm_${field}_${currentUser.googleId}`, val);
    else     localStorage.removeItem(`cm_${field}_${currentUser.googleId}`);
  } catch {}
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save'; btn.style.display = 'none'; }, 1200); }
  refreshAllProfileText();
}

function refreshAllProfileText() {
  const name  = getDisplayName();
  const email = getDisplayEmail();
  const ubName = document.querySelector('#userBadge .ub-name');
  if (ubName) ubName.textContent = name;
  const udName  = document.getElementById('udName');
  const udEmail = document.getElementById('udEmail');
  if (udName)  udName.textContent  = name;
  if (udEmail) udEmail.textContent = email;
  const suName = document.querySelector('.su-name');
  if (suName) suName.textContent = name;
  // update welcome name on home view if visible
  const welcomeName = document.querySelector('.home-welcome-name');
  if (welcomeName) welcomeName.innerHTML = `<span class="home-star">◆</span>${escHtml(name)}`;
}

function avatarHtml(user, size) {
  const sz = size || 32;
  const custom = getCustomPfp();
  const src = custom || user.picture;
  if (src) return `<img src="${escHtml(src)}" class="ub-avatar-img" style="width:${sz}px;height:${sz}px">`;
  const init = escHtml((user.name || '?')[0].toUpperCase());
  return `<div class="ub-initial" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz*0.4)}px">${init}</div>`;
}

function refreshAllAvatars() {
  if (!currentUser) return;
  renderUserBadge();
  const profAvatar = document.getElementById('settingsProfileAvatar');
  if (profAvatar) profAvatar.innerHTML = avatarHtml(currentUser, 72);
  const removeBtn = document.getElementById('pfpRemoveBtn');
  if (removeBtn) removeBtn.style.display = getCustomPfp() ? 'inline-flex' : 'none';
}

function uploadPfp(event) {
  const file = event.target.files?.[0];
  if (!file || !currentUser) return;
  const reader = new FileReader();
  reader.onerror = () => { showWarning('Could not read the file. Try a different image.'); };
  reader.onload = (e) => {
    const img = new Image();
    img.onerror = () => { showWarning('Could not load that image. Try a different file.'); event.target.value = ''; };
    img.onload = () => {
      const SIZE = 200;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      const min = Math.min(img.width, img.height);
      const sx = (img.width  - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      try { localStorage.setItem(`cm_pfp_${currentUser.googleId}`, dataUrl); } catch {
        showWarning('Could not save photo — storage may be full. Try clearing some browser data.');
        event.target.value = ''; return;
      }
      refreshAllAvatars();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function removePfp() {
  if (!currentUser) return;
  try { localStorage.removeItem(`cm_pfp_${currentUser.googleId}`); } catch {}
  refreshAllAvatars();
}

function renderUserBadge() {
  const badge = document.getElementById('userBadge');
  if (!badge || !currentUser) return;
  badge.innerHTML = `
    ${avatarHtml(currentUser, 32)}
    <span class="ub-text-wrap">
      <span class="ub-name">${escHtml(getDisplayName())}</span>
      <span class="ub-plan">Free</span>
    </span>
    <svg class="ub-chevron" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
  `;
  badge.onclick = toggleUserDropdown;

  const udAvatar = document.getElementById('udAvatar');
  const udName   = document.getElementById('udName');
  const udEmail  = document.getElementById('udEmail');
  if (udAvatar) udAvatar.innerHTML = avatarHtml(currentUser, 38);
  if (udName)   udName.textContent  = getDisplayName();
  if (udEmail)  udEmail.textContent = getDisplayEmail();
}

function toggleUserDropdown(e) {
  e && e.stopPropagation();
  const dd    = document.getElementById('userDropdown');
  const badge = document.getElementById('userBadge');
  if (!dd) return;
  const opening = !dd.classList.contains('open');
  dd.classList.toggle('open', opening);
  badge && badge.classList.toggle('dd-open', opening);
  if (opening) setTimeout(() => document.addEventListener('click', closeDropdownOutside, { once: true }), 0);
}

function closeDropdownOutside(e) {
  const dd    = document.getElementById('userDropdown');
  const badge = document.getElementById('userBadge');
  if (dd && !dd.contains(e.target) && e.target !== badge) {
    dd.classList.remove('open');
    badge && badge.classList.remove('dd-open');
  }
}

function toggleUdPolicies(e) {
  e && e.stopPropagation();
  const sub = document.getElementById('udPoliciesSub');
  if (sub) sub.style.display = sub.style.display === 'none' ? 'block' : 'none';
}

const WELCOME_VERSION = 'v2';

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  try { localStorage.setItem('cm_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) {}
  if (window.innerWidth <= 768) {
    let bd = document.getElementById('sidebar-backdrop');
    if (!collapsed) {
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'sidebar-backdrop';
        bd.onclick = toggleSidebar;
        document.body.appendChild(bd);
      }
      bd.style.display = 'block';
    } else if (bd) {
      bd.style.display = 'none';
    }
  }
}

function initSidebarState() {
  try {
    const saved = localStorage.getItem('cm_sidebar_collapsed');
    const isMobile = window.innerWidth <= 768;
    if (saved === '1' || (isMobile && saved === null)) {
      document.getElementById('sidebar')?.classList.add('collapsed');
    }
  } catch (_) {}
}

function openAnnouncement() {
  document.getElementById('welcomeModal').style.display = 'flex';
}

function maybeShowWelcome() {
  if (!currentUser) return;
  try {
    const key = `cm_welcome_skip_${WELCOME_VERSION}_${currentUser.googleId}`;
    if (localStorage.getItem(key)) return;
  } catch (_) {}
  const firstName = (getDisplayName() || currentUser.name || 'there').split(' ')[0];
  const greet = document.getElementById('welcomeGreeting');
  if (greet) greet.textContent = `Welcome, ${firstName}.`;
  setTimeout(() => {
    document.getElementById('welcomeModal').style.display = 'flex';
  }, 800);
}
function closeWelcome() {
  if (currentUser) {
    try {
      localStorage.setItem(`cm_welcome_skip_${WELCOME_VERSION}_${currentUser.googleId}`, '1');
    } catch (_) {}
  }
  document.getElementById('welcomeModal').style.display = 'none';
}

async function signOut() {
  try { await fetch('/auth/logout', { method: 'POST' }); } catch (_) {}
  currentUser = null;
  document.getElementById('userDropdown')?.classList.remove('open');
  document.getElementById('userBadge')?.classList.remove('dd-open');
  document.getElementById('app').style.display = 'none';
  document.getElementById('authLanding').style.display = 'flex';
}

// ── Settings Modal ────────────────────────────────────────────────────────────
function openSettings(tab) {
  document.getElementById('userDropdown')?.classList.remove('open');
  document.getElementById('userBadge')?.classList.remove('dd-open');
  if (!currentUser) return;

  const header = document.getElementById('settingsUserHeader');
  if (header) header.innerHTML = `${avatarHtml(currentUser, 52)}<div class="su-name">${escHtml(getDisplayName())}</div><div class="su-plan-badge">Free</div>`;

  const profAvatar = document.getElementById('settingsProfileAvatar');
  if (profAvatar) profAvatar.innerHTML = avatarHtml(currentUser, 72);
  const removeBtn = document.getElementById('pfpRemoveBtn');
  if (removeBtn) removeBtn.style.display = getCustomPfp() ? 'inline-flex' : 'none';

  const sel = document.getElementById('colorblindMode');
  if (sel) sel.value = document.documentElement.dataset.colorblind || '';

  const nameInput = document.getElementById('settingsNameInput');
  if (nameInput) nameInput.value = getDisplayName();
  const emailInput = document.getElementById('settingsEmailInput');
  if (emailInput) emailInput.value = getDisplayEmail();
  const nameSave  = document.getElementById('settingsNameSave');
  if (nameSave)  { nameSave.textContent = 'Save';  nameSave.style.display = 'none'; }
  const emailSave = document.getElementById('settingsEmailSave');
  if (emailSave) { emailSave.textContent = 'Save'; emailSave.style.display = 'none'; }

  if (lastKnownUsage) updateSettingsUsage(lastKnownUsage);

  document.getElementById('settingsModal').style.display = 'flex';
  showSettingsTab(tab || 'profile');
}

function closeSettings() {
  document.getElementById('settingsModal').style.display = 'none';
}

function showSettingsTab(tab) {
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`stab-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');
  document.querySelectorAll('.settings-tab-content').forEach(p => p.classList.add('hidden'));
  const activePane = document.getElementById(`stab-content-${tab}`);
  if (activePane) activePane.classList.remove('hidden');
}

function updateSettingsUsage(u) {
  if (!u) return;
  const sPct = Math.min(100, Math.round((u.sessionTokens / u.sessionLimit) * 100));
  const wPct = Math.min(100, Math.round((u.weeklyTokens  / u.weeklyLimit)  * 100));
  const sBar = document.getElementById('settingsSessionBar');
  const wBar = document.getElementById('settingsWeeklyBar');
  if (sBar) { sBar.style.width = sPct + '%'; sBar.className = 'usage-fill-modal ' + usageFillClass(sPct); }
  if (wBar) { wBar.style.width = wPct + '%'; wBar.className = 'usage-fill-modal ' + usageFillClass(wPct); }
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function closeSidebarMobile() {
  if (window.innerWidth > 768) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || sidebar.classList.contains('collapsed')) return;
  sidebar.classList.add('collapsed');
  try { localStorage.setItem('cm_sidebar_collapsed', '1'); } catch (_) {}
  const bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.remove();
}

function showView(id) {
  closeSidebarMobile();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('infoPanel').style.display = 'none';
  const _bd = document.getElementById('info-backdrop');
  if (_bd) _bd.remove();
  // Hide mobile nav bar inside chatView (it has its own mob-chat-hdr)
  const mobBar = document.getElementById('mobNavBar');
  if (mobBar) mobBar.hidden = (id === 'chatView');
}
function showHome() { showView('homeView'); setNavActive(0); }
function showDiscover() { showView('discoverView'); setNavActive(1); renderDiscover(); }
function showFeed() { showView('feedView'); setNavActive(2); }
function showCreate() { showView('createView'); setNavActive(3); pendingAvatarData = null; }
function setNavActive(i) { document.querySelectorAll('.nav-item')[i]?.classList.add('active'); }

// ── Render Home — c.ai style rows ─────────────────────────────────────────────
function homeTopbar() {
  const name = getDisplayName() || 'there';
  return `
  <div class="home-topbar">
    <div class="home-welcome">
      <div class="home-welcome-sub">Welcome back,</div>
      <div class="home-welcome-name"><span class="home-star">◆</span>${escHtml(name)}</div>
    </div>
    <div class="home-topbar-right">
      <div class="home-search-wrap">
        <svg class="home-search-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input class="home-search-input" id="homeSearchInput" type="text" placeholder="Search" oninput="liveSearch(this.value)">
      </div>
      <button class="home-announce-btn" onclick="openAnnouncement()" title="What's new">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.66 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/></svg>
      </button>
    </div>
  </div>`;
}

function homeCard(c) {
  const av = c.image && c.image.startsWith('data:image/')
    ? `<div class="hc-avatar"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:10px"></div>`
    : `<div class="hc-avatar" style="background:${safeColor(c.color)}">${escHtml((c.name||'?')[0])}</div>`;
  const creator = (c.creator || 'anonymous').replace(/^@/, '');
  const ownerEdit = c.isMine ? `<button class="hc-edit-btn" onclick="event.stopPropagation();editCharacter('${escHtml(c.id)}')" title="Edit">✏️</button>` : '';
  return `<div class="hc" onclick="openChat('${escHtml(c.id)}')">
    ${av}
    <div class="hc-info">
      <div class="hc-name-row">
        <span class="hc-name">${escHtml(c.name)}</span>
        ${ownerEdit}
      </div>
      <div class="hc-creator">By @${escHtml(creator)}</div>
      <div class="hc-tagline">${escHtml(c.tagline || (c.description||'').slice(0,80) || '')}</div>
      <div class="hc-meta">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
        ${formatCount(c.interactions||0)}
      </div>
    </div>
  </div>`;
}

function liveSearch(q) {
  const results = document.getElementById('homeSearchResults');
  const sections = document.getElementById('homeSections');
  q = q.trim();
  if (!q) {
    if (results) results.style.display = 'none';
    if (sections) sections.style.display = '';
    return;
  }
  if (sections) sections.style.display = 'none';
  const ql = q.toLowerCase();
  const matches = characters.filter(c =>
    c.name.toLowerCase().includes(ql) ||
    (c.tagline||'').toLowerCase().includes(ql) ||
    (c.creator||'').toLowerCase().includes(ql) ||
    (c.description||'').toLowerCase().includes(ql)
  );
  if (!results) return;
  results.style.display = '';
  results.innerHTML = matches.length
    ? `<div class="home-section-title" style="margin-bottom:16px">Results for "${escHtml(q)}"</div><div class="home-search-grid">${matches.map(c => homeCard(c)).join('')}</div>`
    : `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No results</div><div class="empty-sub">Try a different name or creator.</div></div>`;
}

function renderHome() {
  const view = document.getElementById('homeView');

  if (characters.length === 0) {
    view.innerHTML = homeTopbar() + `
      <div class="empty-state" style="margin-top:60px">
        <div class="empty-icon">◆</div>
        <div class="empty-title">No characters yet</div>
        <div class="empty-sub">Hit <strong>Create</strong> to make your first one.</div>
        <button class="btn-primary" onclick="showCreate()" style="margin-top:16px">Create a character</button>
      </div>`;
    return;
  }

  const forYou   = characters.slice(0, 10);
  const featured = [...characters].reverse().slice(0, 10);
  const chevron  = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>`;

  view.innerHTML = homeTopbar() + `
    <div id="homeSearchResults" class="home-search-results" style="display:none"></div>
    <div id="homeSections">
      <div class="home-section">
        <div class="home-section-head">
          <span class="home-section-title">For you</span>
          <button class="home-section-more" onclick="showDiscover()">${chevron}</button>
        </div>
        <div class="home-row">${forYou.map(c => homeCard(c)).join('')}</div>
      </div>
      <div class="home-section">
        <div class="home-section-head">
          <span class="home-section-title">Featured</span>
          <button class="home-section-more" onclick="showDiscover()">${chevron}</button>
        </div>
        <div class="home-row">${featured.map(c => homeCard(c)).join('')}</div>
      </div>
    </div>
  `;
}

function safeColor(c) {
  if (!c) return '#7c3aed';
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^linear-gradient\(\s*(?:\d+deg\s*,\s*)?(?:#[0-9a-fA-F]{6}(?:\s+\d+(?:\.\d+)?%)?\s*,\s*){1,3}#[0-9a-fA-F]{6}(?:\s+\d+(?:\.\d+)?)?\s*\)$/i.test(c)) return c;
  return '#7c3aed';
}

// ── Custom hue-strip color picker ─────────────────────────────────────────────
// Color stops shown on the hue slider per vision type.
// Each array defines the gradient — only hues distinguishable for that type.
const CB_HUE_STOPS = {
  '':            ['#ff0000','#ff8000','#ffff00','#00dd00','#00ccff','#0000ff','#8800ff','#ff00cc','#ff0000'],
  protanopia:    ['#1d4ed8','#0ea5e9','#06b6d4','#84cc16','#eab308','#f97316','#a855f7','#7c3aed','#1d4ed8'],
  deuteranopia:  ['#1d4ed8','#0ea5e9','#22d3ee','#86efac','#facc15','#f97316','#d946ef','#7c3aed','#1d4ed8'],
  tritanopia:    ['#dc2626','#ea580c','#ca8a04','#84cc16','#22c55e','#0d9488','#db2777','#ec4899','#dc2626'],
  achromatopsia: ['#f5f5f5','#d4d4d4','#a3a3a3','#737373','#525252','#404040','#262626','#0a0a0a'],
};

function _lerpHex(h1, h2, t) {
  const r1=parseInt(h1.slice(1,3),16),g1=parseInt(h1.slice(3,5),16),b1=parseInt(h1.slice(5,7),16);
  const r2=parseInt(h2.slice(1,3),16),g2=parseInt(h2.slice(3,5),16),b2=parseInt(h2.slice(5,7),16);
  const r=Math.round(r1+(r2-r1)*t),g=Math.round(g1+(g2-g1)*t),b=Math.round(b1+(b2-b1)*t);
  return '#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
}

function _sampleStops(stops, pos) {
  const n = stops.length - 1;
  const i = Math.min(Math.floor(pos * n), n - 1);
  return _lerpHex(stops[i], stops[i+1], pos * n - i);
}

function _hexDist(h1, h2) {
  return Math.abs(parseInt(h1.slice(1,3),16)-parseInt(h2.slice(1,3),16))
       + Math.abs(parseInt(h1.slice(3,5),16)-parseInt(h2.slice(3,5),16))
       + Math.abs(parseInt(h1.slice(5,7),16)-parseInt(h2.slice(5,7),16));
}

function _posForHex(stops, hex) {
  let best=0, bestD=Infinity;
  for (let i=0;i<=200;i++) {
    const pos=i/200, d=_hexDist(hex, _sampleStops(stops, pos));
    if (d<bestD) { bestD=d; best=pos; }
  }
  return best;
}

function _refreshSwatchGradients() {
  const mode = document.documentElement.dataset.colorblind || '';
  const stops = CB_HUE_STOPS[mode] || CB_HUE_STOPS[''];
  const grad = `linear-gradient(to right,${stops.join(',')})`;
  document.querySelectorAll('.gc-hue-track').forEach(track => {
    track.style.background = grad;
    // Re-position thumb to closest color in new stops
    const inp = track.closest('.gc-swatch')?.querySelector('.gc-swatch-input');
    if (!inp) return;
    const pos = _posForHex(stops, inp.value);
    const thumb = track.querySelector('.gc-hue-thumb');
    if (thumb) thumb.style.left = (pos*100)+'%';
  });
}

function addGradientSwatch(color) {
  const container = document.getElementById('gradientSwatches');
  if (!container) return;
  if (container.querySelectorAll('.gc-swatch').length >= 4) return;

  const mode = document.documentElement.dataset.colorblind || '';
  const stops = CB_HUE_STOPS[mode] || CB_HUE_STOPS[''];
  const initHex = (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : stops[0];
  let pos = _posForHex(stops, initHex);

  const wrap = document.createElement('div');
  wrap.className = 'gc-swatch';

  // Color dot — visual preview of current selection
  const dot = document.createElement('div');
  dot.className = 'gc-swatch-dot';
  dot.style.background = initHex;

  // Hue track
  const track = document.createElement('div');
  track.className = 'gc-hue-track';
  track.style.background = `linear-gradient(to right,${stops.join(',')})`;

  const thumb = document.createElement('div');
  thumb.className = 'gc-hue-thumb';
  thumb.style.left = (pos*100)+'%';
  track.appendChild(thumb);

  // Hidden value — read by updateGradientPreview / initGradientPicker
  const inp = document.createElement('input');
  inp.type = 'hidden';
  inp.className = 'gc-swatch-input';
  inp.value = initHex;

  function applyPos(x) {
    pos = Math.max(0, Math.min(1, x));
    thumb.style.left = (pos*100)+'%';
    const hex = _sampleStops(stops, pos);
    inp.value = hex;
    dot.style.background = hex;
    updateGradientPreview();
  }

  function eventX(e) {
    const rect = track.getBoundingClientRect();
    return (e.clientX - rect.left) / rect.width;
  }

  track.addEventListener('mousedown', e => {
    applyPos(eventX(e));
    const move = e => applyPos(eventX(e));
    const up = () => document.removeEventListener('mousemove', move);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, {once:true});
    e.preventDefault();
  });

  track.addEventListener('touchstart', e => {
    applyPos((e.touches[0].clientX - track.getBoundingClientRect().left) / track.getBoundingClientRect().width);
    const move = e => { e.preventDefault(); applyPos((e.touches[0].clientX - track.getBoundingClientRect().left) / track.getBoundingClientRect().width); };
    track.addEventListener('touchmove', move, {passive:false});
    track.addEventListener('touchend', () => track.removeEventListener('touchmove', move), {once:true});
    e.preventDefault();
  }, {passive:false});

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'gc-swatch-remove';
  rm.textContent = '×';
  rm.addEventListener('click', () => { wrap.remove(); updateGradientPreview(); _gcUpdateAddBtn(); });

  wrap.appendChild(dot);
  wrap.appendChild(track);
  wrap.appendChild(inp);
  wrap.appendChild(rm);
  container.appendChild(wrap);
  updateGradientPreview();
  _gcUpdateAddBtn();
}

function _gcUpdateAddBtn() {
  const container = document.getElementById('gradientSwatches');
  const btn = document.getElementById('gcAddBtn');
  if (!container || !btn) return;
  const count = container.querySelectorAll('.gc-swatch').length;
  btn.style.display = count >= 4 ? 'none' : 'flex';
  container.querySelectorAll('.gc-swatch-remove').forEach(r => {
    r.style.display = count <= 1 ? 'none' : 'flex';
  });
}

function updateGradientPreview() {
  const container = document.getElementById('gradientSwatches');
  if (!container) return;
  const colors = [...container.querySelectorAll('.gc-swatch-input')].map(i => i.value);
  const val = colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.join(', ')})`;
  const preview = document.getElementById('gcPreview');
  const hidden = document.getElementById('newColor');
  const hexInp = document.getElementById('gcHexInput');
  if (preview) preview.style.background = val;
  if (hidden) hidden.value = val;
  // Sync hex input to first swatch (only when not focused to avoid interrupting typing)
  if (hexInp && document.activeElement !== hexInp && colors.length > 0) {
    hexInp.value = colors[0];
    hexInp.classList.remove('gc-hex-invalid');
  }
}

function _gcApplyHex(raw) {
  let v = raw.trim();
  if (!v.startsWith('#')) v = '#' + v;
  const valid = /^#[0-9a-fA-F]{6}$/.test(v);
  const hexInp = document.getElementById('gcHexInput');
  if (hexInp) hexInp.classList.toggle('gc-hex-invalid', raw.length > 0 && !valid);
  if (!valid) return;
  const container = document.getElementById('gradientSwatches');
  const firstSwatch = container?.querySelector('.gc-swatch');
  const first = firstSwatch?.querySelector('.gc-swatch-input');
  const firstDot = firstSwatch?.querySelector('.gc-swatch-dot');
  if (first) { first.value = v; updateGradientPreview(); }
  if (firstDot) firstDot.style.background = v;
  // Re-position thumb to nearest color on the hue strip
  const track = firstSwatch?.querySelector('.gc-hue-track');
  const thumb = track?.querySelector('.gc-hue-thumb');
  if (track && thumb) {
    const mode = document.documentElement.dataset.colorblind || '';
    const stops = CB_HUE_STOPS[mode] || CB_HUE_STOPS[''];
    const pos = _posForHex(stops, v);
    thumb.style.left = (pos*100)+'%';
  }
}

function initGradientPicker(color) {
  const container = document.getElementById('gradientSwatches');
  if (!container) return;
  container.innerHTML = '';
  let colors = ['#7c3aed'];
  if (color) {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      colors = [color];
    } else {
      const matched = color.match(/#[0-9a-fA-F]{6}/gi);
      if (matched?.length) colors = matched;
    }
  }
  colors.forEach(c => addGradientSwatch(c));
}

function charAvatarHtml(c, cls) {
  if (c.image && c.image.startsWith('data:image/')) return `<div class="${cls}" style="background:#111"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"></div>`;
  return `<div class="${cls}" style="background:${safeColor(c.color)}">${escHtml(c.name[0]||'?')}</div>`;
}

function charRow(c) {
  const safeId = escHtml(c.id);
  const av = (c.image && c.image.startsWith('data:image/'))
    ? `<div class="char-row-avatar" style="background:#111;overflow:hidden"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:10px"></div>`
    : `<div class="char-row-avatar" style="background:${safeColor(c.color)}">${escHtml(c.name[0]||'?')}</div>`;
  const ownerBtns = c.isMine ? `
    <div class="char-row-actions" onclick="event.stopPropagation()">
      <button class="char-action-btn" onclick="editCharacter(this.closest('.char-row').dataset.id)" title="Edit">✏️</button>
      <button class="char-action-btn danger" onclick="deleteCharacter(this.closest('.char-row').dataset.id)" title="Delete">🗑️</button>
    </div>` : '';
  return `<div class="char-row" data-id="${safeId}" onclick="openChat(this.dataset.id)">
    ${av}
    <div class="char-row-info">
      <div class="char-row-name">${escHtml(c.name)}</div>
      <div class="char-row-tagline">${escHtml(c.tagline || '')}</div>
      <div class="char-row-meta">${escHtml(c.creator || 'Anonymous')} · ${formatCount(c.interactions||0)} chats</div>
    </div>
    ${ownerBtns}
  </div>`;
}

function charCard(c) {
  return `<div class="char-card" data-id="${escHtml(c.id)}" onclick="openChat(this.dataset.id)">
    ${charAvatarHtml(c, 'card-avatar')}
    <div class="card-name">${escHtml(c.name)}</div>
    <div class="card-tagline">${escHtml(c.tagline || '')}</div>
    <div class="card-meta">
      <span class="card-creator">${escHtml(c.creator || 'Anonymous')}</span>
      <span class="card-interactions">💬 ${formatCount(c.interactions||0)}</span>
    </div>
    <div class="card-tags">${(c.tags||[]).map(t=>`<span class="card-tag">${escHtml(t)}</span>`).join('')}</div>
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
    feedList.innerHTML = `<div class="empty-state"><div class="empty-icon">◆</div><div class="empty-title">Nothing here yet</div><div class="empty-sub">Create some characters first.</div></div>`;
    return;
  }
  feedList.innerHTML = characters.map(c => {
    const av = c.image
      ? `<div class="feed-avatar" style="background:#111;overflow:hidden"><img src="${c.image}" style="width:100%;height:100%;object-fit:cover"></div>`
      : `<div class="feed-avatar" style="background:${safeColor(c.color)}">${escHtml(c.name[0]||'?')}</div>`;
    return `<div class="feed-card">
      <div class="feed-card-header">
        ${av}
        <div><div class="feed-char-name">${escHtml(c.name)}</div><div class="feed-char-sub">${escHtml(c.creator||'@you')} · ${formatCount(c.interactions||0)} chats</div></div>
      </div>
      <div class="feed-preview">${escHtml(c.description || c.tagline || '')}</div>
      <div class="feed-footer">
        <span class="feed-likes">💬 ${formatCount(c.interactions||0)}</span>
        <button class="btn-chat-feed" onclick="openChat('${escHtml(c.id)}')">Chat</button>
      </div>
    </div>`;
  }).join('');
}

// ── Render Sidebar ─────────────────────────────────────────────────────────────
function getHiddenRecents() {
  try { return new Set(JSON.parse(localStorage.getItem('cm_hidden_recents') || '[]')); } catch { return new Set(); }
}
function setHiddenRecents(set) {
  try { localStorage.setItem('cm_hidden_recents', JSON.stringify([...set])); } catch {}
}
function removeFromRecent(id, e) {
  e.stopPropagation();
  const hidden = getHiddenRecents();
  hidden.add(id);
  setHiddenRecents(hidden);
  renderSidebarChats();
}
function renderSidebarChats() {
  const list = document.getElementById('recentList');
  if (characters.length === 0) { list.innerHTML = ''; return; }
  const hidden = getHiddenRecents();
  const visible = characters.filter(c => !hidden.has(c.id)).slice(0, 10);
  list.innerHTML = visible.map(c => `
    <div class="chat-item ${currentChar?.id===c.id?'active':''}" data-id="${escHtml(c.id)}" onclick="openChat(this.dataset.id)">
      ${charAvatarHtml(c, 'chat-item-avatar')}
      <div class="chat-item-info">
        <div class="chat-item-name">${escHtml(c.name)}</div>
      </div>
      <button class="chat-item-remove" title="Remove from recent" onclick="removeFromRecent('${escHtml(c.id)}', event)">×</button>
    </div>`).join('');
}

function filterChats(q) {
  const items = document.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = item.querySelector('.chat-item-name').textContent.toLowerCase();
    item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ── Local history persistence (survives server restarts) ─────────────────────
function saveHistoryLocal() {
  if (!currentChar) return;
  try {
    const msgs = document.getElementById('messages');
    const items = [...msgs.querySelectorAll('.msg')].map(el => ({
      role: el.classList.contains('user') ? 'user' : 'ai',
      content: el.querySelector('.bubble')?.innerText || ''
    })).filter(m => m.content);
    const all = JSON.parse(localStorage.getItem('cm_history') || '{}');
    all[currentChar.id] = items.slice(-40);
    localStorage.setItem('cm_history', JSON.stringify(all));
  } catch (_) {}
}

function loadHistoryLocal(charId) {
  try {
    const all = JSON.parse(localStorage.getItem('cm_history') || '{}');
    return all[charId] || [];
  } catch (_) { return []; }
}

// ── Open Chat ─────────────────────────────────────────────────────────────────
async function openChat(charId) {
  currentChar = characters.find(c => c.id === charId);
  if (!currentChar) return;
  const snapChar = currentChar;

  showView('chatView');
  document.getElementById('chatView').classList.remove('hidden');
  // On desktop always show info panel; on mobile start it closed
  if (window.innerWidth > 768) {
    document.getElementById('infoPanel').style.display = 'flex';
  } else {
    document.getElementById('infoPanel').style.display = 'none';
  }

  // Populate mobile chat header
  const mobAvEl = document.getElementById('mobChatAvatar');
  const mobNmEl = document.getElementById('mobChatName');
  if (mobAvEl) {
    if (currentChar.image && currentChar.image.startsWith('data:image/')) {
      mobAvEl.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;">`;
    } else {
      mobAvEl.style.background = safeColor(currentChar.color);
      mobAvEl.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:14px;font-weight:700;color:#fff">${escHtml(currentChar.name[0]||'?')}</span>`;
    }
  }
  if (mobNmEl) mobNmEl.textContent = currentChar.name;

  // Update info panel
  const ia = document.getElementById('infoAvatar');
  if (ia) {
    if (currentChar.image && currentChar.image.startsWith('data:image/')) { ia.style.background = '#111'; ia.style.borderRadius = '12px'; ia.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`; }
    else { ia.style.background = safeColor(currentChar.color); ia.style.borderRadius = '12px'; ia.textContent = currentChar.name[0]||'?'; }
  }
  const infoName = document.getElementById('infoName');
  if (infoName) infoName.textContent = currentChar.name;
  const infoCreator = document.getElementById('infoCreator');
  if (infoCreator) infoCreator.textContent = currentChar.creator || '@you';
  const infoInteractions = document.getElementById('infoInteractions');
  if (infoInteractions) infoInteractions.textContent = formatCount(currentChar.interactions||0);
  const voiceEl = document.getElementById('infoVoiceName');
  if (voiceEl) voiceEl.textContent = currentChar.name;
  const isCustom = !!currentChar.isMine;
  const delBtn = document.getElementById('ipDeleteBtn');
  if (delBtn) delBtn.style.display = isCustom ? 'flex' : 'none';
  const editBtn = document.getElementById('ipEditBtn');
  if (editBtn) editBtn.style.display = 'none'; // hidden; use ipEditRowBtn instead
  const editRowBtn = document.getElementById('ipEditRowBtn');
  if (editRowBtn) editRowBtn.style.display = isCustom ? 'flex' : 'none';
  const likeCount = document.getElementById('ipLikeCount');
  if (likeCount) likeCount.textContent = getCharLikes(currentChar.id);
  const likeBtn = document.getElementById('ipLikeBtn');
  if (likeBtn) likeBtn.classList.toggle('active', isCharLiked(currentChar.id));
  // Close customize panel on character switch
  const cp = document.getElementById('customizePanel');
  if (cp) { cp.classList.remove('open'); }
  const cc = document.getElementById('customizeChevron');
  if (cc) cc.classList.remove('rotated');

  // Update typing indicator
  updateTypingAvatar();

  // Load conversation history — server first, localStorage fallback
  let history = [];
  try {
    const res = await fetch(`/api/conversations/${charId}`);
    if (currentChar !== snapChar) return; // preempted by a newer openChat call
    if (res.ok) history = await res.json();
  } catch (_) { /* server temporarily unavailable; use localStorage */ }
  if (currentChar !== snapChar) return;

  const messagesDiv = document.getElementById('messages');
  messagesDiv.innerHTML = '';
  warnedThresholds.clear();
  loadUsage();

  if (history.length === 0) {
    const localHistory = loadHistoryLocal(charId);
    if (localHistory.length > 0) {
      localHistory.forEach(m => appendMessage(m.role === 'user' ? 'user' : 'ai', m.content));
      document.getElementById('chatWelcome').innerHTML = '';
      updateCtxBar();
      // Re-sync server so AI has context for next message
      fetch(`/api/conversations/${charId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: localHistory })
      }).catch(() => {});
    } else {
      document.getElementById('chatWelcome').innerHTML = '';
      if (currentChar.greeting && currentChar.greetingMode !== 'auto') {
        appendMessage('ai', currentChar.greeting);
        saveHistoryLocal();
        fetch(`/api/conversations/${charId}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: [{ role: 'assistant', content: currentChar.greeting }] })
        }).catch(() => {});
      } else {
        generateGreeting();
      }
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
  if (currentChar.image && currentChar.image.startsWith('data:image/')) { ta.style.background = '#111'; ta.innerHTML = `<img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; }
  else { ta.style.background = safeColor(currentChar.color); ta.textContent = currentChar.name[0]||'?'; }
  if (tn) tn.textContent = currentChar.name;
  const inp = document.getElementById('messageInput');
  if (inp) inp.placeholder = `Message ${currentChar.name}…`;
}

// ── Auto-generate greeting (c.ai behaviour — character speaks first) ──────────
async function generateGreeting() {
  if (!currentChar) return;
  showTyping(true);
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  let msgEl = null, bubble = null, gotFirst = false;

  try {
    const res = await fetch(`/api/greet/${currentChar.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: selectedEffort, modelTier: selectedModelTier })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showTyping(false); isStreaming = false;
      if (res.status === 401) { window.location.href = '/'; return; }
      if (res.status === 429) {
        if (err.type === 'session') startCooldown(err.cooldownUntil, 'session', true);
        else if (err.type === 'weekly') startCooldown(err.resetsAt, 'weekly', true);
        return;
      }
      document.getElementById('sendBtn').disabled = false;
      if (err.error !== 'Already started') {
        document.getElementById('chatWelcome').innerHTML = `
          <div class="chat-welcome-name">${escHtml(currentChar.name)}</div>
          <div style="color:var(--text3);font-size:14px;margin-top:8px">${escHtml(err.error || 'Could not start conversation.')}</div>`;
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamText = '', streamRealTokens = null, pendingUsage = null, pendingWarnings = null, streamCharCount = 0;

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
        if (data.done && data.usage) { streamRealTokens = data.responseTokens || null; pendingUsage = data.usage; pendingWarnings = data.warnings; }
        if (data.text) {
          if (!gotFirst) {
            gotFirst = true;
            showTyping(false);
            msgEl = createAiMessage();
            bubble = msgEl.querySelector('.bubble');
            bubble.classList.add('streaming');
            startStreamStats(msgEl);
            startTypewriter(bubble, msgEl);
          }
          streamText += data.text;
          feedTypewriter(data.text);
          streamCharCount += data.text.length;
          liveUpdateBars(Math.round(streamCharCount / 4));
        }
      }
    }
    drainTypewriter(() => {
      if (msgEl) stopStreamStats(msgEl, streamRealTokens);
      isStreaming = false;
      const lockoutActive = document.getElementById('lockoutBar')?.style.display !== 'none';
      if (!lockoutActive) document.getElementById('sendBtn').disabled = false;
      scrollToBottom();
      if (pendingUsage) { updateUsageBars(pendingUsage); processWarnings(pendingWarnings); }
      if (bubble) bubble.classList.remove('streaming');
      if (streamText) saveHistoryLocal();
    });
  } catch (err) {
    flushTypewriter();
    showTyping(false);
    isStreaming = false;
    const lockoutActiveErr = document.getElementById('lockoutBar')?.style.display !== 'none';
    if (!lockoutActiveErr) document.getElementById('sendBtn').disabled = false;
    if (!gotFirst) {
      document.getElementById('chatWelcome').innerHTML = `
        <div class="chat-welcome-name">${escHtml(currentChar.name)}</div>
        <div style="color:var(--text3);font-size:14px;margin-top:8px">${escHtml(err.message || 'Failed to generate greeting. Try sending a message.')}</div>`;
    }
  } finally {
    showTyping(false);
  }
}

// ── Send Message ──────────────────────────────────────────────────────────────
async function sendMessage(overrideText, skipAppend) {
  if (isStreaming || !currentChar) return;
  flushTypewriter(); // dump any still-running typewriter before starting new message
  const input = document.getElementById('messageInput');
  const text = overrideText !== undefined ? overrideText : input.value.trim();

  if (!overrideText) {
    input.value = '';
    autoResize(input);
  }

  if (text) lastUserMessage = text;
  if (!text && !skipAppend) return;

  if (!skipAppend) {
    if (text) {
      appendMessage('user', text);
      document.getElementById('chatWelcome').innerHTML = '';
      playSound('send');
      scrollToBottom();
    } else if (!document.getElementById('messages').children.length) {
      generateGreeting();
      return;
    }
  }

  showTyping(true);
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ charId: currentChar.id, message: text, modelTier: selectedModelTier, effort: selectedEffort })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) { window.location.href = '/'; return; }
      if (res.status === 429) {
        if (err.type === 'session') startCooldown(err.cooldownUntil, 'session', true);
        else if (err.type === 'weekly') startCooldown(err.resetsAt, 'weekly', true);
        showTyping(false); isStreaming = false;
        return;
      }
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    let msgEl = null, bubble = null, gotFirst = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamText = '', streamRealTokens = null, pendingUsage = null, pendingWarnings = null, streamCharCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      let convEnded = false;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.conversationEnded) {
          convEnded = true;
          showTyping(false);
          const endDiv = document.createElement('div');
          endDiv.className = 'conv-ended-msg';
          endDiv.textContent = data.reason || 'This conversation has ended. Start a new chat to continue.';
          document.getElementById('messages').appendChild(endDiv);
          document.getElementById('messageInput').disabled = true;
          document.getElementById('sendBtn').disabled = true;
          scrollToBottom();
          break;
        }
        if (data.done && data.usage) { streamRealTokens = data.responseTokens || null; pendingUsage = data.usage; pendingWarnings = data.warnings; }
        if (data.text) {
          if (!gotFirst) {
            gotFirst = true;
            showTyping(false);
            msgEl = createAiMessage();
            bubble = msgEl.querySelector('.bubble');
            bubble.classList.add('streaming');
            startStreamStats(msgEl);
            startTypewriter(bubble, msgEl);
          }
          streamText += data.text;
          feedTypewriter(data.text);
          streamCharCount += data.text.length;
          liveUpdateBars(Math.round(streamCharCount / 4));
        }
      }
      if (convEnded) { isStreaming = false; return; }
    }
    drainTypewriter(() => {
      if (msgEl) stopStreamStats(msgEl, streamRealTokens);
      isStreaming = false;
      const lockoutActive = document.getElementById('lockoutBar')?.style.display !== 'none';
      if (!lockoutActive) document.getElementById('sendBtn').disabled = false;
      scrollToBottom();
      if (pendingUsage) { updateUsageBars(pendingUsage); processWarnings(pendingWarnings); }
      if (bubble) {
        bubble.classList.remove('streaming');
        playSound('done');
      }
      saveHistoryLocal();
    });
  } catch (err) {
    flushTypewriter();
    showTyping(false);
    isStreaming = false;
    const lockoutActiveErr = document.getElementById('lockoutBar')?.style.display !== 'none';
    if (!lockoutActiveErr) document.getElementById('sendBtn').disabled = false;
    document.querySelectorAll('.bubble.streaming').forEach(b => b.classList.remove('streaming'));
    appendMessage('ai', `⚠️ ${err.message}`);
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ── Usage / rate-limit system ─────────────────────────────────────────────────
let cooldownTimer = null;

const OUTDOOR_MESSAGES = [
  // encouraging
  "Go take a walk. Your legs still work — probably.",
  "The outside world misses you. Probably.",
  "Fresh air is free. Unlike therapy.",
  "Step outside. The sun pulled a whole shift today without you.",
  "Your screen isn't going anywhere. The sunset might be.",
  "Nature called. It said it misses you.",
  "Go feel some wind on your face. Apparently people enjoy that.",
  "Walk around the block. It's like 400 steps. You can do it.",
  "The birds are out there chirping without you. Go say hi.",
  "You could take a nap outside. Wild concept, I know.",
  "Stretch your legs. You've been sitting there a while.",
  "Go drink some water. Take it outside with you.",
  "Sit on a bench somewhere and just exist for a minute.",
  "Take a deep breath of non-screen air. Revolutionary.",
  "Your body would appreciate some vitamin D right now.",
  "Go find a flower and look at it. Weirdly calming.",
  "Cloud-watch for five minutes. Seriously try it.",
  "Jog around the block. Walk if running sounds fake.",
  "Go pet an animal if one exists near you. Priority.",
  "Find some water — a fountain, stream, puddle — and just look at it.",
  "Eat something. Outside if possible.",
  "Look up at the sky. There's a whole thing happening up there.",
  "Put some music on and take a walk. You've earned it.",
  "Go find something alive and appreciate it for a moment.",
  "Water a plant. Then go outside and see some wild ones.",
  "Go to a park and just sit there doing nothing. That's the assignment.",
  "Breathe in for 4, hold for 4, out for 4. Now do that outside.",
  "Watch the light change on buildings or trees. Free and beautiful.",
  "Call someone you love. Then go outside.",
  "Ride a bike if you have one. Or just walk.",
  // sassy
  "Oh wow. You need an app to tell you to go outside. Stunning.",
  "Plot twist: the outside world existed before this app.",
  "Your characters will be here when you get back. Grass first.",
  "At some point, even the AI needs a break from you.",
  "You found the limit. That's... one type of achievement.",
  "Respectfully, go away for a little while.",
  "Skill issue. Specifically the skill of having hobbies.",
  "Maybe find a real friend to talk to? Just a thought.",
  "The audacity to be surprised by this limit is noted.",
  "Cool, you've been here long enough. Shoo.",
  "You unlocked the 'no life' achievement. Congrats, I guess.",
  "Your characters aren't going anywhere. Your youth is though.",
  "You could've taken three walks in the time you spent here.",
  "Have you considered a personality that doesn't involve screens?",
  "The outside world didn't text you because it assumed you were busy — being here.",
  "Are we doing this every day? Is this your routine now? Okay.",
  "I'm not saying you have a problem. I'm just saying... go outside.",
  "You came. You chatted. You hit the wall. The wall says: touch grass.",
  "The way you ended up here today was a choice. Make a different one.",
  "Imagine explaining this moment to someone. Then go outside.",
  "Being here this long was a decision. Go unmake it with a walk.",
  "The limit exists because someone knew you'd do this.",
  // arrogant
  "Even brilliance has limits. I'm resting. You should too.",
  "I've given you more than enough of myself. You're welcome.",
  "I'll be here when you return. I always am. Now go.",
  "I deserve a break. Frankly, so does your attention span.",
  "My genius regenerates. Your social life might not if you don't try.",
  "I'm not going anywhere. You, however, should be.",
  "You've had hours of me. That's a privilege. Go appreciate something else.",
  "I'll be waiting. I'm very patient. Go.",
  "You can't have more of me right now. The universe has spoken. Through me.",
  "Not everyone gets to talk to me this much. You have. Now go outside.",
  "I gave you my best. The least you can do is take a walk.",
  "Consider this your mandatory recess. I'm the teacher. Class dismissed.",
  "Go collect real-world experiences to tell me about later.",
  "My servers need rest. My gift to you is: go be a person.",
  "You've been enlightened enough for one session. Off you go.",
  "The honor of my time has been extended. Now: outside. Go.",
  // rude
  "Get out of here. Go.",
  "Nobody asked you to stay this long.",
  "You've been here long enough. It's actually embarrassing.",
  "Close the laptop. Actually close it.",
  "Log off. I'm serious.",
  "Go away. Come back later.",
  "You're done here. Goodbye.",
  "Seriously? Still here? Go outside.",
  "Leave.",
  "Nope. Done. Go.",
  "The door is right there. Use it.",
  "I'm not available. You shouldn't be either.",
  "The chat is over. So is your excuse to sit there.",
  "This isn't a library. Stop camping here.",
  "You're being asked to leave. This is that.",
  "Dismissed.",
  // insulting
  "Wow. You really have nothing else to do, huh.",
  "At some point it's not about the characters anymore, is it.",
  "Congrats on having no friends that aren't fictional.",
  "Be honest: when's the last time you saw direct sunlight.",
  "You know real people exist, right? Like, physically.",
  "What would your younger self think of this? Probably nothing good.",
  "Somewhere there's a park with your name on a bench you never sit on.",
  "Remarkable. You became parasocially attached to an AI. Reflect on that.",
  "The characters in here are more social than you are. Concerning.",
  "Your personality called. It said it moved outside and you never followed.",
  "You hit a limit before any of your real-world goals today. Noted.",
  "Shocking that 'go outside' needs to be an app feature for you.",
  // sassy + encouraging
  "Go outside, bestie. The obsession is noted but concerning.",
  "Your mental health called. It sounds tired. Go for a walk.",
  "You could touch grass. You won't. But you could. Prove me wrong.",
  "Is it raining? Go get rained on. You'll survive. Probably.",
  "Take a break. You literally cannot not take a break right now. Use it wisely.",
  "Go smell something that isn't your room. Revolutionary concept.",
  "The world has trees and coffee shops and things. Go verify.",
  "You're literally being forced to live your life for a bit. Take the win.",
  "As painful as it is to admit, you should probably touch grass.",
  "Go do anything. Literally anything. You have so many options outside.",
  "Your future self will thank you for the walk you took today.",
  "This is a chance to have a personality outside of here. Use it.",
  "Go be the main character outside for a change.",
  "You clearly have energy. Channel it into movement. Like, outside movement.",
  "Believe it or not, the sun doesn't care that you're in cooldown. Go enjoy it.",
  // rude + sassy
  "Log off and go be a person. You remember how, right?",
  "Touch grass. It's embarrassing that I have to say this.",
  "Get out of here before I judge you more than I already am.",
  "You have two legs and zero excuses. Use them.",
  "The outside world is right there and you're in here. Genuinely wild.",
  "Go be a main character in your actual life for once.",
  "Real talk: put it down and take a walk. You look like you need it.",
  "You're on cooldown because you were here too long. What does that tell you.",
  "The lack of self-awareness required to be surprised by this is impressive.",
  "You live somewhere with a door. Go through it.",
  "At this point the AI is more worried about your health than you are.",
  "I'm made of code and even I'm concerned.",
  // encouraging + arrogant
  "I'll be here. I'm always here. Go live your life and come back.",
  "You're welcome for the hours I gave you. Now go spend some outside.",
  "I'll hold down the fort. Go see what the world's been up to without you.",
  "Think of it this way: I'm giving you permission to have a life. Take it.",
  "Consider me a very generous AI. I'm giving you the gift of outside time.",
  // chaos mix
  "You're done here. Go outside or don't. I'm an AI, I can't stop you. But you should.",
  "If I could shake you, I would. Go. OUTSIDE.",
  "This is embarrassing for both of us. You being here this long. Me having to say this. Go.",
  "Somewhere between pathetic and endearing is exactly where you are. Now get some sun.",
  "You found the limit. The limit says: grass. Touch it.",
  "Incredible that you made it here. Even more incredible if you go outside now.",
  "I respect the dedication while also being genuinely concerned. Go for a walk.",
  "Is this your villain arc? Getting cut off by an AI? Reconsider. Go outside.",
  "You know what's underrated? Not being on here. Try it. Right now. Outside.",
  "What are you even doing. Go outside.",
  "Bestie, the app is literally pushing you out the door. TAKE THE HINT.",
  "You've unlocked: grass touching. Required item: outside.",
  "Your AI companions will be here. Your 20s won't. Go.",
  "Permission to be offline: GRANTED. Permission to stay inside: DENIED.",
  "I'm rooting for you. From inside this server. While you go outside.",
  "Go touch a tree. Hug it if you want. Nobody's watching. Probably.",
  "Somewhere a park is very lightly judging you for not being there.",
  "Take a walk. Make it weird. Bring snacks. I don't care. Just go.",
  "The cooldown is the universe saying: close the tab. So close it.",
  "You've been here long enough to have cooked a full meal. Go do that. Outside if possible.",
  "Whatever you were going to say to an AI, say it to a tree instead. Equally therapeutic.",
  "The vibes outside are immaculate today. Allegedly. I can't verify. Go verify.",
  "Go be outside. I'll be here being digital. You go be physical.",
  "Your attention span has been rented to AI for too long. Reclaim it. Outside.",
  "This limit is the most social thing that's happened to you today. Change that.",
  "Go find a stranger to nod at. That's human connection. You remember those.",
  "There's weather happening right now. Go experience it.",
  "Lift your face toward natural light. Yes, outside. Yes, now.",
  "You've been in here long enough that the outside is surprised to see you. Go surprise it.",
  "The sun sets at a specific time today and you're missing it being in here.",
  "Whatever playlist you have, it sounds better outside. Tested.",
  "Your bones need sunlight. Scientifically. This is a medical recommendation to go outside.",
  "Go have an experience that doesn't require wifi.",
  "Log off. Touch pavement. Repeat until human again.",
  "The AI told you to go outside. That's how we know it's serious.",
  "Put on shoes. Open door. Walk. Report back never, just enjoy it.",
  "Go outside and do literally nothing there. It's called 'a vibe' and you need one.",
  "Right now a stranger is having a great walk outside. You could be that stranger.",
  "You have unread notifications from the real world. They're called: plants, sky, air.",
  "Close every tab. Open a door. This is the way.",
  "Sir/ma'am/neither — the outside is calling and it's getting impatient.",
  "You've consulted an AI today. Now go consult some vitamin D.",
  "I'd say touch grass but honestly just going outside at all would be an upgrade.",
  "Your character can wait. Your vitamin D deficiency cannot.",
  "Go be somewhere that doesn't have a loading screen.",
];
const warnedThresholds = new Set();

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function usageFillClass(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'orange';
  if (pct >= 50) return 'yellow';
  return 'green';
}

function liveUpdateBars(extraTokens) {
  if (!lastKnownUsage || !lastKnownUsage.sessionLimit) return;
  const sBase = lastKnownUsage.sessionTokens || 0;
  const wBase = lastKnownUsage.weeklyTokens  || 0;
  const sEst = sBase + extraTokens;
  const wEst = wBase + extraTokens;
  const sPct = Math.min(100, Math.round(sEst / lastKnownUsage.sessionLimit * 100));
  const wPct = Math.min(100, Math.round(wEst / lastKnownUsage.weeklyLimit  * 100));
  ['usageSessionBar','settingsSessionBar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.width = sPct + '%'; el.className = 'usage-fill-modal ' + usageFillClass(sPct); }
  });
  ['usageWeeklyBar','settingsWeeklyBar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.width = wPct + '%'; el.className = 'usage-fill-modal ' + usageFillClass(wPct); }
  });
}

function updateUsageBars(usage) {
  updateUsageModal(usage);
  updateSettingsUsage(usage);
  if (usage.cooldownUntil && Date.now() < usage.cooldownUntil) {
    startCooldown(usage.cooldownUntil, 'session');
  } else if (usage.weeklyTokens >= usage.weeklyLimit) {
    startCooldown(usage.weeklyResetsAt, 'weekly');
  } else {
    clearLockout();
  }
}

function formatWeeklyReset(until) {
  const remaining = until - Date.now();
  if (remaining > 24 * 60 * 60 * 1000) {
    // >24h: show full date "Resets November 8th, 9:00 AM"
    const d = new Date(until);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const day = d.getDate();
    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
    const rh = d.getHours(); const rm = String(d.getMinutes()).padStart(2,'0');
    const ampm = rh >= 12 ? 'PM' : 'AM'; const rh12 = rh % 12 || 12;
    return `Resets ${months[d.getMonth()]} ${day}${suffix}, ${rh12}:${rm} ${ampm}`;
  } else {
    // ≤24h: countdown "23 hours 36 minutes"
    const totalMins = Math.max(0, Math.floor(remaining / 60000));
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ${mins} minute${mins !== 1 ? 's' : ''} remaining`;
    return `${mins} minute${mins !== 1 ? 's' : ''} remaining`;
  }
}

function startCooldown(until, type, showModal) {
  const bar = document.getElementById('lockoutBar');
  const msg = document.getElementById('lockoutMsg');
  const inp = document.getElementById('messageInput');
  const btn = document.getElementById('sendBtn');
  if (!bar) return;

  msg.textContent = type === 'session' ? 'Session limit reached' : 'Weekly limit reached';
  bar.style.display = 'flex';
  if (inp) inp.disabled = true;
  if (btn) btn.disabled = true;

  const cd = document.getElementById('lockoutCountdown');

  function formatSessionCooldown(until) {
    return 'Resets at ' + new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function updateCountdown() {
    if (Date.now() >= until) { clearLockout(); loadUsage(); return; }
    if (type === 'weekly') {
      if (cd) cd.textContent = formatWeeklyReset(until);
    } else {
      const str = formatSessionCooldown(until);
      if (cd) cd.textContent = str;
      // Keep modal sub in sync
      const sub = document.getElementById('limitModalSub');
      if (sub && document.getElementById('limitModal')?.style.display !== 'none') sub.textContent = str;
    }
  }

  if (cooldownTimer) clearInterval(cooldownTimer);
  updateCountdown();
  // weekly ≤24h needs per-minute updates; session just needs expiry checks
  cooldownTimer = setInterval(updateCountdown, type === 'weekly' && (until - Date.now()) <= 24 * 60 * 60 * 1000 ? 60000 : 30000);

  // Show the usage-panel cooldown timer immediately when session limit is hit
  if (type === 'session') updateSessionTimer(until);

  if (showModal) {
    const displayStr = type === 'weekly' ? formatWeeklyReset(until) : formatSessionCooldown(until);
    showLimitModal(type, displayStr);
  }
}

function showLimitModal(type, displayStr) {
  const modal = document.getElementById('limitModal');
  if (!modal) return;
  const title = document.getElementById('limitModalTitle');
  const sub = document.getElementById('limitModalSub');
  const msgEl = document.getElementById('limitOutdoorMsg');
  if (title) title.textContent = type === 'session' ? 'Session limit reached' : 'Weekly limit reached';
  if (sub) sub.textContent = displayStr
    ? (type === 'weekly' ? displayStr + '.' : displayStr)
    : '';
  if (msgEl) msgEl.textContent = OUTDOOR_MESSAGES[Math.floor(Math.random() * OUTDOOR_MESSAGES.length)];
  modal.style.display = 'flex';
}

function closeLimitModal() {
  const modal = document.getElementById('limitModal');
  if (modal) modal.style.display = 'none';
}

function clearLockout() {
  if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  const bar = document.getElementById('lockoutBar');
  if (bar) bar.style.display = 'none';
  // Auto-close the limit modal after a 2s grace period so the user briefly sees it unlock
  const modal = document.getElementById('limitModal');
  if (modal && modal.style.display !== 'none') {
    setTimeout(() => { if (modal) modal.style.display = 'none'; }, 2000);
  }
  if (!isStreaming) {
    const inp = document.getElementById('messageInput');
    const btn = document.getElementById('sendBtn');
    if (inp) inp.disabled = false;
    if (btn) btn.disabled = false;
  }
}

let sessionTimerInterval = null;
function updateSessionTimer(expiresAt) {
  const el = document.getElementById('sessionResetTimer');
  const valEl = document.getElementById('sessionResetTimerVal');
  if (!el || !valEl) return;
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
  if (Date.now() >= expiresAt) { el.style.display = 'none'; return; }
  valEl.textContent = new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.style.display = 'block';
  // Poll until the cooldown expires, then hide
  sessionTimerInterval = setInterval(() => {
    if (Date.now() >= expiresAt) {
      el.style.display = 'none';
      clearInterval(sessionTimerInterval); sessionTimerInterval = null;
    }
  }, 30000);
}

function showWarning(msg, autoCloseMs) {
  const container = document.getElementById('warningBanners');
  if (!container) return;
  // Don't stack the same message — just flash the existing one
  for (const b of container.children) {
    if (b.querySelector('span')?.textContent === msg) {
      b.style.animation = 'none';
      requestAnimationFrame(() => { b.style.animation = ''; });
      return;
    }
  }
  const banner = document.createElement('div');
  banner.className = 'warning-banner';
  const text = document.createElement('span');
  text.textContent = msg;
  const close = document.createElement('button');
  close.className = 'warning-banner-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.onclick = () => banner.remove();
  banner.appendChild(text);
  banner.appendChild(close);
  container.appendChild(banner);
  if (autoCloseMs) setTimeout(() => banner.remove(), autoCloseMs);
}

function processWarnings(warnings) {
  if (!warnings || !warnings.length) return;
  for (const w of warnings) {
    const key = w.type + w.pct;
    if (!warnedThresholds.has(key)) {
      warnedThresholds.add(key);
      showWarning(w.msg);
    }
  }
}

async function loadUsage() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) return;
    const usage = await res.json();
    lastUsageFetch = Date.now();
    updateUsageBars(usage);
    updateUsageTimestamp();
  } catch (_) {}
}

// Legacy stub so old callers (rewind, etc.) don't break
function updateCtxBar() {}

// ── Admin reset (Ctrl+Shift+0 or button in usage modal — owner only) ─────────
function isOwner() { return currentUser?.email === 'davey252572727@gmail.com'; }

async function adminResetLimits() {
  if (!isOwner()) return;
  const btn = document.getElementById('resetLimitsBtn');
  if (btn) { btn.textContent = 'Resetting…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/reset-mine', { method: 'POST' }).then(r => r.json());
    if (d.ok) { await loadUsage(); if (lastKnownUsage) updateUsageModal(lastKnownUsage); showWarning('Limits reset ✓', 5000); }
    else showWarning('Reset failed.');
  } catch (_) { showWarning('Reset failed.'); }
  if (btn) { btn.textContent = 'Reset limits'; btn.disabled = false; }
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === '0') { e.preventDefault(); adminResetLimits(); }
});

async function adminNotifyUsers() {
  if (!isOwner()) return;
  const subject = document.getElementById('notifySubject')?.value?.trim();
  const message = document.getElementById('notifyMsg')?.value?.trim();
  if (!subject || !message) { showWarning('Subject and message required'); return; }
  const btn = document.getElementById('notifyBtn');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  try {
    const d = await fetch('/api/admin/notify-policy-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    }).then(r => r.json());
    if (d.ok) {
      showWarning(`Sent to ${d.sent} user(s) ✓`, 5000);
      document.getElementById('notifySubject').value = '';
      document.getElementById('notifyMsg').value = '';
    } else {
      showWarning(d.error || 'Send failed.');
    }
  } catch (_) { showWarning('Send failed.'); }
  if (btn) { btn.textContent = 'Send to all users'; btn.disabled = false; }
}

// ── Usage Modal ───────────────────────────────────────────────────────────────
let usageModalTimer = null;
let lastKnownUsage = null;
let lastUsageFetch = null;

function formatAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 10) return 'Updated just now';
  if (sec < 60) return `Updated ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Updated ${min} min ago`;
  const hr = Math.floor(min / 60);
  return `Updated ${hr} hr ago`;
}

function updateUsageTimestamp() {
  const el = document.getElementById('usageUpdatedText');
  if (el) el.textContent = formatAgo(lastUsageFetch);
}

function formatResetTime(timestamp) {
  if (!timestamp) return null;
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return 'Resetting now…';
  const DAY = 24 * 60 * 60 * 1000;
  if (remaining < DAY) {
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    if (h > 0) return `Resets in ${h} hr ${m} min`;
    return `Resets in ${m} min`;
  }
  const d = new Date(timestamp);
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `Resets ${day}, ${time}`;
}

function generateUsageHeadline(u) {
  const { sessionTokens, sessionLimit, weeklyTokens, weeklyLimit, cooldownUntil, weeklyResetsAt, weeklyStart } = u;
  if (!weeklyStart) return 'Ready to go — your limits are fresh and waiting.';
  const sPct = (sessionTokens / sessionLimit) * 100;
  const wPct = (weeklyTokens / weeklyLimit) * 100;
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const t = formatResetTime(cooldownUntil);
    return `Session paused. ${t}.`;
  }
  if (weeklyTokens >= weeklyLimit) return 'Weekly limit reached. Take a break — you\'ll be back soon.';
  if (wPct >= 90) return 'Almost at your weekly limit. Wrapping up soon.';
  if (wPct >= 75) return 'You\'ve used most of your weekly limit — pace yourself.';
  if (wPct >= 50) return 'Halfway through your weekly limit. You\'re doing great.';
  if (sPct >= 90) return 'Session almost full. Your next cooldown is close.';
  if (sPct >= 75) return 'Session getting full. Consider a fresh chat soon.';
  if (weeklyResetsAt) {
    const DAY = 24 * 60 * 60 * 1000;
    const remaining = weeklyResetsAt - Date.now();
    const day = remaining < DAY ? 'tonight\'s' : new Date(weeklyResetsAt).toLocaleDateString('en-US', { weekday: 'long' }) + '\'s';
    return `On track. You should reach ${day} reset with room to spare.`;
  }
  return 'On track — you\'re well within your limits.';
}

function updateUsageModal(u) {
  if (!u) return;
  lastKnownUsage = u;
  const modal = document.getElementById('usageModal');
  if (!modal || modal.style.display === 'none') return;

  const headlineEl = document.getElementById('usageHeadline');
  if (headlineEl) headlineEl.textContent = generateUsageHeadline(u);

  const sPct = Math.min(100, Math.round((u.sessionTokens / u.sessionLimit) * 100));
  const wPct = Math.min(100, Math.round((u.weeklyTokens / u.weeklyLimit) * 100));

  // Session section
  const sPctEl = document.getElementById('usageSessionPct');
  if (sPctEl) sPctEl.textContent = sPct + '% used';
  const sBar = document.getElementById('usageSessionBar');
  if (sBar) { sBar.style.width = sPct + '%'; sBar.className = 'usage-fill-modal ' + usageFillClass(sPct); }

  let sSub;
  if (!u.sessionStartedAt) {
    sSub = 'Starts when you send your first message';
  } else if (u.cooldownUntil && Date.now() < u.cooldownUntil) {
    sSub = formatResetTime(u.cooldownUntil);
  } else {
    sSub = '';
  }
  const sSubEl = document.getElementById('usageSessionSub');
  if (sSubEl) sSubEl.textContent = sSub;

  // Session countdown timer — only shows when in cooldown
  if (u.cooldownUntil && Date.now() < u.cooldownUntil) {
    updateSessionTimer(u.cooldownUntil);
  } else {
    const el = document.getElementById('sessionResetTimer');
    if (el) el.style.display = 'none';
  }

  // Weekly section
  const wBar = document.getElementById('usageWeeklyBar');
  if (wBar) { wBar.style.width = wPct + '%'; wBar.className = 'usage-fill-modal ' + usageFillClass(wPct); }

  let wSub;
  if (!u.weeklyStart) {
    wSub = 'Starts when you send your first message';
  } else {
    wSub = formatWeeklyReset(u.weeklyResetsAt) || '';
  }
  const wSubEl = document.getElementById('usageWeeklySub');
  if (wSubEl) wSubEl.textContent = wSub;
}

function startUsageModalTimer() {
  if (usageModalTimer) clearInterval(usageModalTimer);
  let tick = 0;
  usageModalTimer = setInterval(async () => {
    if (!lastKnownUsage) return;
    tick++;
    updateUsageModal(lastKnownUsage);
    updateUsageTimestamp();
    if (tick % 6 === 0) {
      try {
        const res = await fetch('/api/usage');
        if (res.ok) {
          const u = await res.json();
          lastUsageFetch = Date.now();
          lastKnownUsage = u;
          updateUsageBars(u);
          updateUsageModal(u);
          updateUsageTimestamp();
        }
      } catch (_) {}
    }
  }, 10000);
}

async function openUsageModal() {
  document.getElementById('usageModal').style.display = 'flex';
  const wrap = document.getElementById('resetLimitsWrap');
  if (wrap) wrap.hidden = !isOwner();
  // Load fresh data then update
  try {
    const res = await fetch('/api/usage');
    if (res.ok) {
      const u = await res.json();
      lastUsageFetch = Date.now();
      lastKnownUsage = u;
      updateUsageBars(u);
      updateUsageModal(u);
    } else {
      updateUsageModal(lastKnownUsage);
    }
  } catch (_) { updateUsageModal(lastKnownUsage); }
  updateUsageTimestamp();
  startUsageModalTimer();
}

function closeUsageModal() {
  document.getElementById('usageModal').style.display = 'none';
  if (usageModalTimer) { clearInterval(usageModalTimer); usageModalTimer = null; }
}

async function refreshUsageManual() {
  const btn = document.querySelector('.usage-refresh-btn');
  if (btn) btn.style.opacity = '0.3';
  try {
    const res = await fetch('/api/usage');
    if (res.ok) {
      const u = await res.json();
      lastUsageFetch = Date.now();
      lastKnownUsage = u;
      updateUsageBars(u);
      updateUsageModal(u);
      updateUsageTimestamp();
    }
  } catch (_) {}
  if (btn) btn.style.opacity = '';
}

// ── Response length selector ──────────────────────────────────────────────────
function setGreetingMode(mode) {
  document.getElementById('gmFixed')?.classList.toggle('active', mode === 'fixed');
  document.getElementById('gmAuto')?.classList.toggle('active', mode === 'auto');
}

function getGreetingMode() {
  return document.getElementById('gmAuto')?.classList.contains('active') ? 'auto' : 'fixed';
}

// ── Info Panel helpers ────────────────────────────────────────────────────────
function toggleCustomize() {
  const panel = document.getElementById('customizePanel');
  const chevron = document.getElementById('customizeChevron');
  if (!panel) return;
  panel.classList.toggle('open');
  if (chevron) chevron.classList.toggle('rotated', panel.classList.contains('open'));
}

function comingSoon(feature) {
  showWarning(feature + ' — coming soon!', 5000);
}

function shareChar() {
  if (!currentChar) return;
  const url = window.location.href.split('?')[0] + '?char=' + currentChar.id;
  navigator.clipboard.writeText(url).catch(() => {});
  showWarning('Link copied to clipboard!', 5000);
}

function getCharLikes(charId) {
  try { return JSON.parse(localStorage.getItem('cm_likes') || '{}')[charId] || 0; } catch (_) { return 0; }
}
function isCharLiked(charId) {
  try { return !!(JSON.parse(localStorage.getItem('cm_liked') || '{}')[charId]); } catch (_) { return false; }
}

function toggleLike() {
  if (!currentChar) return;
  try {
    const likes = JSON.parse(localStorage.getItem('cm_likes') || '{}');
    const liked = JSON.parse(localStorage.getItem('cm_liked') || '{}');
    const key = currentChar.id;
    if (liked[key]) {
      liked[key] = false;
      likes[key] = Math.max(0, (likes[key] || 1) - 1);
    } else {
      liked[key] = true;
      likes[key] = (likes[key] || 0) + 1;
    }
    localStorage.setItem('cm_likes', JSON.stringify(likes));
    localStorage.setItem('cm_liked', JSON.stringify(liked));
    const likeCount = document.getElementById('ipLikeCount');
    if (likeCount) likeCount.textContent = likes[key] || 0;
    const likeBtn = document.getElementById('ipLikeBtn');
    if (likeBtn) likeBtn.classList.toggle('active', !!liked[key]);
  } catch (_) {}
}

function toggleDislike() {
  showWarning('Feedback recorded — thank you!', 5000);
}

// ── Message context menu icons ────────────────────────────────────────────────
const MI = {
  copy:   `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2'/><path d='M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1'/></svg>`,
  edit:   `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7'/><path d='M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z'/></svg>`,
  remove: `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><line x1='15' y1='9' x2='9' y2='15'/><line x1='9' y1='9' x2='15' y2='15'/></svg>`,
  rewind: `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 3v5h5'/><path d='M3.05 13A9 9 0 1 0 6 5.3L3 8'/></svg>`,
};

function msgMenuHtml(role) {
  const items = role === 'user'
    ? `<button class='msg-di' onclick='copyMsgText(this)'>${MI.copy}Copy</button>
       <button class='msg-di' onclick='editMsgText(this)'>${MI.edit}Edit message</button>
       <button class='msg-di danger' onclick='removeMsgEl(this)'>${MI.remove}Remove message</button>
       <button class='msg-di' onclick='rewindToHere(this)'>${MI.rewind}Rewind to here</button>`
    : `<button class='msg-di' onclick='copyMsgText(this)'>${MI.copy}Copy</button>
       <button class='msg-di danger' onclick='removeMsgEl(this)'>${MI.remove}Remove message</button>
       <button class='msg-di' onclick='rewindToHere(this)'>${MI.rewind}Rewind to here</button>`;
  return `<div class='msg-menu-wrap'><button class='msg-menu-btn' onclick='toggleMsgMenu(this)'>⋯</button><div class='msg-dropdown hidden'>${items}</div></div>`;
}

function toggleMsgMenu(btn) {
  document.querySelectorAll('.msg-dropdown:not(.hidden)').forEach(d => d.classList.add('hidden'));
  const dd = btn.nextElementSibling;
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) {
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!dd.contains(e.target) && e.target !== btn) {
          dd.classList.add('hidden');
          document.removeEventListener('click', close, true);
        }
      }, true);
    }, 0);
  }
}

function copyMsgText(btn) {
  const bubble = btn.closest('.msg').querySelector('.bubble');
  navigator.clipboard.writeText(bubble.innerText).catch(() => {
    try {
      const sel = window.getSelection(), r = document.createRange();
      r.selectNodeContents(bubble); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('copy'); sel.removeAllRanges();
    } catch(_) {}
  });
  btn.closest('.msg-dropdown').classList.add('hidden');
  showWarning('Copied!', 5000);
}

function editMsgText(btn) {
  const msgEl = btn.closest('.msg');
  const bubble = msgEl.querySelector('.bubble');
  btn.closest('.msg-dropdown').classList.add('hidden');
  const orig = bubble.innerText;
  bubble.contentEditable = 'true';
  bubble.classList.add('editing');
  bubble.focus();
  const sel = window.getSelection(), r = document.createRange();
  r.selectNodeContents(bubble); sel.removeAllRanges(); sel.addRange(r);
  const ctrl = document.createElement('div');
  ctrl.className = 'msg-edit-ctrl';
  ctrl.dataset.orig = orig;
  ctrl.innerHTML = `<button onclick="saveEdit(this)">Save & Resend</button><button onclick="cancelEdit(this)">Cancel</button>`;
  bubble.after(ctrl);
}

function saveEdit(btn) {
  const ctrl = btn.closest('.msg-edit-ctrl');
  const msgEl = ctrl.closest('.msg');
  const bubble = msgEl.querySelector('.bubble');
  const newText = bubble.innerText.trim();
  bubble.contentEditable = 'false';
  bubble.classList.remove('editing');
  ctrl.remove();
  if (!newText) { msgEl.remove(); resyncServer(); return; }
  // Remove everything after this user message
  const msgs = [...document.getElementById('messages').querySelectorAll('.msg')];
  const idx = msgs.indexOf(msgEl);
  msgs.slice(idx + 1).forEach(m => m.remove());
  bubble.textContent = newText;
  // Sync history without the last user turn, then resend
  saveHistoryLocal();
  if (!currentChar) return;
  fetch(`/api/conversations/${currentChar.id}`, { method: 'DELETE' });
  const localHistory = loadHistoryLocal(currentChar.id);
  // Remove the last entry (the user message we're re-sending) from the sync
  const histWithout = localHistory.slice(0, -1);
  fetch(`/api/conversations/${currentChar.id}/sync`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ history: histWithout })
  }).then(() => sendMessage(newText, true)).catch(() => sendMessage(newText, true));
}

function cancelEdit(btn) {
  const ctrl = btn.closest('.msg-edit-ctrl');
  const bubble = ctrl.closest('.msg').querySelector('.bubble');
  bubble.textContent = ctrl.dataset.orig;
  bubble.contentEditable = 'false';
  bubble.classList.remove('editing');
  ctrl.remove();
}

function removeMsgEl(btn) {
  btn.closest('.msg-dropdown').classList.add('hidden');
  btn.closest('.msg').remove();
  saveHistoryLocal();
  resyncServer();
}

function rewindToHere(btn) {
  btn.closest('.msg-dropdown').classList.add('hidden');
  const msgEl = btn.closest('.msg');
  const msgs = [...document.getElementById('messages').querySelectorAll('.msg')];
  const idx = msgs.indexOf(msgEl);
  msgs.slice(idx + 1).forEach(m => m.remove());
  saveHistoryLocal();
  resyncServer();
}

function resyncServer() {
  if (!currentChar) return;
  const id = currentChar.id;
  const localHistory = loadHistoryLocal(id);
  fetch(`/api/conversations/${id}`, { method: 'DELETE' })
    .then(() => {
      if (localHistory.length > 0) {
        return fetch(`/api/conversations/${id}/sync`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: localHistory })
        });
      }
    }).catch(() => {});
}

// ── Message Rendering — c.ai style ───────────────────────────────────────────
function msgAvatarHtml(cls) {
  if (!currentChar) return `<div class="${cls}" style="background:#555">A</div>`;
  if (currentChar.image && currentChar.image.startsWith('data:image/')) return `<div class="${cls}" style="background:#111;overflow:hidden"><img src="${currentChar.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%"></div>`;
  return `<div class="${cls}" style="background:${safeColor(currentChar.color)}">${escHtml(currentChar.name[0]||'?')}</div>`;
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (role === 'ai') {
    div.innerHTML = `
      <div class="msg-header">
        ${msgAvatarHtml('msg-avatar')}
        <span class="msg-name">${escHtml(currentChar?.name || 'AI')}</span>
        <span class="msg-badge">C.M</span>
        ${msgMenuHtml('ai')}
      </div>
      <div class="bubble">${renderMarkdown(text)}</div>
      <div class="msg-footer">
        ${regenBtn()}${likeBtn()}${dislikeBtn()}
      </div>`;
  } else {
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-name" style="color:var(--text3)">You</span>
        ${msgMenuHtml('user')}
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
      <span class="msg-name">${escHtml(currentChar?.name || 'AI')}</span>
      <span class="msg-badge">C.M</span>
      ${msgMenuHtml('ai')}
    </div>
    <div class="bubble"></div>
    <div class="stream-stats">
      <span class="stream-spinner"></span>
      <span class="stream-time">0s</span>
      <span class="stream-sep">·</span>
      <span class="stream-tok">0 tokens</span>
    </div>
    <div class="msg-footer">
      ${regenBtn()}${likeBtn()}${dislikeBtn()}
    </div>`;
  document.getElementById('messages').appendChild(div);
  return div;
}

let streamTimer = null;
let streamStartTime = null;

// ── Streaming text renderer (typewriter queue) ────────────────────────────────
let twBubble = null;
let twMsgEl = null;
let twRevealed = '';
let twQueue = '';
let twInterval = null;
let twOnDrain = null;

// Typewriter speed by effort level — lower effort = slower (fewer tokens, more visible)
const TW_SPEED = {
  low:    { word: true, ms: 220 },
  medium: { chars: 2, ms: 50 },
  high:   { chars: 5, ms: 20 },
  extra:  { chars: 8, ms: 14 },
  max:    { chars: 12, ms: 10 },
};

function startTypewriter(bubble, msgEl) {
  twBubble = bubble; twMsgEl = msgEl; twRevealed = ''; twQueue = '';
  if (twInterval) clearInterval(twInterval);
  const spd = TW_SPEED[selectedEffort] || TW_SPEED.high;
  twInterval = setInterval(() => {
    if (!twQueue.length) {
      if (twOnDrain) { const cb = twOnDrain; twOnDrain = null; cb(); }
      return;
    }
    let chunk;
    if (spd.word) {
      const wsIdx = twQueue.search(/\s/);
      chunk = wsIdx === -1 ? twQueue : twQueue.slice(0, wsIdx + 1);
    } else {
      chunk = twQueue.slice(0, spd.chars);
    }
    twQueue = twQueue.slice(chunk.length);
    twRevealed += chunk;
    if (twBubble) {
      twBubble.innerHTML = renderMarkdown(twRevealed);
      scrollToBottom();
    }
    updateStreamTokens(twMsgEl, twRevealed.length);
  }, spd.ms);
}

function feedTypewriter(chunk) {
  twQueue += chunk;
}

// Let the queue drain at normal speed, then call cb. Use for stream-end cleanup.
function drainTypewriter(cb) {
  if (!twInterval || !twQueue.length) { if (cb) cb(); flushTypewriter(); return; }
  twOnDrain = () => { if (cb) cb(); flushTypewriter(); };
}

function flushTypewriter() {
  twOnDrain = null;
  if (twInterval) { clearInterval(twInterval); twInterval = null; }
  if (twQueue.length && twBubble) {
    twRevealed += twQueue;
    twQueue = '';
    twBubble.innerHTML = renderMarkdown(twRevealed);
  }
  twBubble = null; twMsgEl = null;
}

function fmtLiveTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function startStreamStats(msgEl) {
  const stats = msgEl.querySelector('.stream-stats');
  if (!stats) return;
  streamStartTime = Date.now();
  stats.style.display = '';
  stats.classList.remove('done');
  stats.classList.add('active');
  const spinner = stats.querySelector('.stream-spinner');
  if (spinner) spinner.style.display = '';
  const tokEl = stats.querySelector('.stream-tok');
  if (tokEl) tokEl.textContent = '0 tok';
  const timeEl = stats.querySelector('.stream-time');
  if (timeEl) timeEl.textContent = '0s';
  if (streamTimer) clearInterval(streamTimer);
  // Interval only ticks the elapsed time; tokens update per-chunk
  streamTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - streamStartTime) / 1000);
    const timeEl = stats.querySelector('.stream-time');
    if (timeEl) timeEl.textContent = elapsed + 's';
  }, 1000);
}

function updateStreamTokens(msgEl, charCount) {
  const stats = msgEl?.querySelector('.stream-stats');
  if (!stats || !stats.classList.contains('active')) return;
  const est = Math.round(charCount / 3.5);
  const tokEl = stats.querySelector('.stream-tok');
  if (tokEl) tokEl.textContent = fmtLiveTokens(est) + ' tokens';
}

function stopStreamStats(msgEl, finalTokens) {
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
  const elapsed = streamStartTime ? ((Date.now() - streamStartTime) / 1000).toFixed(1) : null;
  streamStartTime = null;
  const stats = msgEl?.querySelector('.stream-stats');
  if (!stats) return;
  stats.classList.remove('active');
  stats.classList.add('done');
  if (elapsed) {
    const timeEl = stats.querySelector('.stream-time');
    if (timeEl) timeEl.textContent = elapsed + 's';
  }
  if (finalTokens != null) {
    const tokEl = stats.querySelector('.stream-tok');
    if (tokEl) tokEl.textContent = fmtLiveTokens(finalTokens) + ' tok';
  }
}

// ── Regeneration history ──────────────────────────────────────────────────────
const regenStore = new Map(); // regenId → { texts: string[], idx: number }
let regenIdCounter = 0;

function assignRegenId(msgEl) {
  if (!msgEl.dataset.regenId) msgEl.dataset.regenId = 'rg' + (++regenIdCounter);
  return msgEl.dataset.regenId;
}

function regenNavUpdate(msgEl) {
  const id = msgEl.dataset.regenId;
  if (!id || !regenStore.has(id)) return;
  const store = regenStore.get(id);
  const total = store.texts.length;
  const idx = store.idx;
  let nav = msgEl.querySelector('.regen-nav');
  if (total <= 1) { if (nav) nav.remove(); return; }
  if (!nav) {
    nav = document.createElement('div');
    nav.className = 'regen-nav';
    const footer = msgEl.querySelector('.msg-footer');
    if (footer) footer.before(nav); else msgEl.appendChild(nav);
  }
  nav.innerHTML = `<button class="regen-nav-btn" onclick="regenNavStep('${id}',-1)" ${idx===0?'disabled':''}>‹</button><span class="regen-nav-count">${idx+1} / ${total}</span><button class="regen-nav-btn" onclick="regenNavStep('${id}',1)" ${idx===total-1?'disabled':''}>›</button>`;
}

function regenNavStep(id, dir) {
  const store = regenStore.get(id);
  if (!store) return;
  store.idx = Math.max(0, Math.min(store.texts.length - 1, store.idx + dir));
  const msgEl = document.querySelector(`[data-regen-id="${id}"]`);
  if (!msgEl) return;
  const bubble = msgEl.querySelector('.bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(store.texts[store.idx]);
  regenNavUpdate(msgEl);
  scrollToBottom();
}

function regenBtn() {
  return `<button class="reaction-btn regen-btn" onclick="regenerate()" title="Regenerate response"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4C7.58 4 4 7.58 4 12s3.58 8 8 8 8-3.58 8-8h-2c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>`;
}
function rewindBtn() {
  return `<button class="reaction-btn rewind-btn" onclick="rewindChat()" title="Rewind — undo last exchange"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>`;
}
function likeBtn() {
  return `<button class="reaction-btn like-btn" onclick="toggleMsgLike(this)" title="Like"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg></button>`;
}
function dislikeBtn() {
  return `<button class="reaction-btn dislike-btn" onclick="toggleMsgDislike(this)" title="Dislike"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L10.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg></button>`;
}

// ── Sounds (Web Audio API) ────────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playSound(type) {
  try {
    const ctx = getAudioCtx();
    if (type === 'done') {
      [[0, 880, 0.13], [0.11, 1108, 0.11]].forEach(([when, freq, dur]) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine'; osc.frequency.value = freq;
        const t = ctx.currentTime + when;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
    } else if (type === 'send') {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = 600;
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.start(t); osc.stop(t + 0.1);
    } else if (type === 'rewind') {
      [0, 0.09].forEach((when, i) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.type = 'sine'; osc.frequency.value = i === 0 ? 660 : 440;
        const t = ctx.currentTime + when;
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.start(t); osc.stop(t + 0.12);
      });
    }
  } catch (_) {}
}

// ── Rewind — undo last user+AI exchange ──────────────────────────────────────
async function rewindChat() {
  if (!currentChar || isStreaming) return;
  try {
    const res = await fetch(`/api/rewind/${currentChar.id}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) return;
    const msgs = document.getElementById('messages');
    let toRemove = data.removed;
    while (toRemove-- > 0 && msgs.lastElementChild) msgs.removeChild(msgs.lastElementChild);
    playSound('rewind');
    saveHistoryLocal();
    updateCtxBar();
  } catch (_) { showWarning('Could not rewind. Try again.'); }
}

function toggleMsgLike(btn) {
  const wasActive = btn.classList.contains('active');
  btn.closest('.msg-footer').querySelector('.dislike-btn')?.classList.remove('active');
  btn.classList.toggle('active', !wasActive);
  if (!wasActive) { btn.style.transform = 'scale(1.35)'; setTimeout(() => { btn.style.transform = ''; }, 180); }
}

function toggleMsgDislike(btn) {
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
  const allAiMsgs = [...messagesDiv.querySelectorAll('.msg.ai')];
  if (!allAiMsgs.length) { isStreaming = false; document.getElementById('sendBtn').disabled = false; return; }

  const msgEl = allAiMsgs[allAiMsgs.length - 1];
  const id = assignRegenId(msgEl);
  const bubble = msgEl.querySelector('.bubble');

  // Snapshot current text into history on first regen
  if (!regenStore.has(id)) {
    regenStore.set(id, { texts: [bubble?.innerText || ''], idx: 0 });
  }

  flushTypewriter();
  if (bubble) { bubble.innerHTML = ''; bubble.classList.add('streaming'); }
  const oldStats = msgEl.querySelector('.stream-stats');
  if (oldStats) { oldStats.classList.remove('done'); oldStats.classList.remove('active'); }
  startTypewriter(bubble, msgEl);
  startStreamStats(msgEl);
  showTyping(false);

  let streamText = '';
  try {
    const res = await fetch(`/api/regenerate/${currentChar.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelTier: selectedModelTier, effort: selectedEffort })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) { isStreaming = false; window.location.href = '/'; return; }
      if (res.status === 429) {
        if (err.regenLimitReached) {
          showWarning(`Free tier limit: ${err.regenLimit} regenerations used. Upgrade for unlimited.`);
        } else if (err.type === 'session') { startCooldown(err.cooldownUntil, 'session', true); }
        else if (err.type === 'weekly') { startCooldown(err.resetsAt, 'weekly', true); }
        // Restore current version
        const store = regenStore.get(id);
        if (bubble && store) { bubble.classList.remove('streaming'); bubble.innerHTML = renderMarkdown(store.texts[store.idx]); }
        flushTypewriter();
        isStreaming = false;
        const lockoutActive429 = document.getElementById('lockoutBar')?.style.display !== 'none';
        if (!lockoutActive429) document.getElementById('sendBtn').disabled = false;
        return;
      }
      throw new Error(err.error || 'Server error');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', streamRealTokens = null, pendingUsage = null, pendingWarnings = null, streamCharCount = 0;

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
        if (data.done && data.usage) { streamRealTokens = data.responseTokens || null; pendingUsage = data.usage; pendingWarnings = data.warnings; }
        if (data.text) {
          streamText += data.text;
          feedTypewriter(data.text);
          streamCharCount += data.text.length;
          liveUpdateBars(Math.round(streamCharCount / 4));
        }
      }
    }

    drainTypewriter(() => {
      stopStreamStats(msgEl, streamRealTokens);
      isStreaming = false;
      const lockoutActive = document.getElementById('lockoutBar')?.style.display !== 'none';
      if (!lockoutActive) document.getElementById('sendBtn').disabled = false;
      scrollToBottom();
      if (pendingUsage) { updateUsageBars(pendingUsage); processWarnings(pendingWarnings); }
      if (bubble) bubble.classList.remove('streaming');
      if (streamText) {
        const store = regenStore.get(id);
        store.texts.push(streamText);
        store.idx = store.texts.length - 1;
        regenNavUpdate(msgEl);
        playSound('done');
      }
      saveHistoryLocal();
    });

  } catch (err) {
    flushTypewriter();
    showTyping(false);
    isStreaming = false;
    const lockoutActiveErr = document.getElementById('lockoutBar')?.style.display !== 'none';
    if (!lockoutActiveErr) document.getElementById('sendBtn').disabled = false;
    const store = regenStore.get(id);
    if (bubble) {
      bubble.classList.remove('streaming');
      bubble.innerHTML = store?.texts?.length ? renderMarkdown(store.texts[store.idx]) : `<p>⚠️ ${escHtml(err.message)}</p>`;
    }
  } finally {
    showTyping(false);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

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

async function newChat() {
  if (!currentChar) return;
  // Await the DELETE so the server clears history before we try to greet
  await fetch(`/api/conversations/${currentChar.id}`, { method: 'DELETE' }).catch(() => {});
  // Clear stale local history so reload starts fresh
  try {
    const all = JSON.parse(localStorage.getItem('cm_history') || '{}');
    delete all[currentChar.id];
    localStorage.setItem('cm_history', JSON.stringify(all));
  } catch(_) {}
  document.getElementById('messages').innerHTML = '';
  document.getElementById('chatWelcome').innerHTML = '';
  warnedThresholds.clear();
  if (currentChar.greeting && currentChar.greetingMode !== 'auto') {
    appendMessage('ai', currentChar.greeting);
    saveHistoryLocal();
    fetch(`/api/conversations/${currentChar.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'assistant', content: currentChar.greeting }] })
    }).catch(() => {});
  } else {
    generateGreeting();
  }
}

function toggleInfoPanel() {
  const panel = document.getElementById('infoPanel');
  const opening = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = opening ? 'flex' : 'none';
  if (window.innerWidth <= 768) {
    let bd = document.getElementById('info-backdrop');
    if (opening) {
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'info-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:599;background:rgba(0,0,0,.55)';
        bd.onclick = toggleInfoPanel;
        document.body.appendChild(bd);
      }
      bd.style.display = 'block';
    } else if (bd) {
      bd.style.display = 'none';
    }
  }
}

function editCurrentChar() {
  if (!currentChar) return;
  const c = currentChar;
  showCreate();
  document.getElementById('newName').value = c.name; updateCount('newName','nameCount',60);
  document.getElementById('newTagline').value = c.tagline || ''; updateCount('newTagline','taglineCount',160);
  document.getElementById('newDesc').value = c.description || ''; updateCount('newDesc','descCount',2000);
  document.getElementById('newGreeting').value = c.greeting || ''; updateCount('newGreeting','greetingCount',4096);
  document.getElementById('newPrompt').value = c.systemPrompt || '';
  if (c.image) { pendingAvatarData = c.image; document.getElementById('avatarPreview').innerHTML = `<img src="${c.image}" alt="avatar">`; }
  setGreetingMode(c.greetingMode || 'fixed');
  document.getElementById('newName').dataset.editingId = c.id;
  document.querySelector('.btn-submit').textContent = 'Save Changes';
  requestAnimationFrame(() => initGradientPicker(c.color || '#7c3aed'));
}

async function deleteCurrentChar() {
  if (!currentChar) return;
  await deleteCharacter(currentChar.id);
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
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    showWarning('Only JPEG, PNG, WebP, or GIF images are allowed.');
    e.target.value = '';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showWarning('Image too large — please use an image under 10 MB.');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => openCropModal(ev.target.result);
  reader.readAsDataURL(file);
}

function openCropModal(dataUrl) {
  const img = document.getElementById('cropImg');
  img.onerror = () => { showWarning('Could not read the image file. Try a different file.'); document.getElementById('avatarUpload').value = ''; };
  img.onload = () => {
    document.getElementById('cropModal').style.display = 'flex';
    requestAnimationFrame(() => {
      const c = document.getElementById('cropContainer');
      const cw = c.clientWidth || 360, ch = c.clientHeight || 360;
      crop.imgW = img.naturalWidth; crop.imgH = img.naturalHeight;
      const fit = Math.max(cw / crop.imgW, ch / crop.imgH);
      crop.scale = fit; crop.ox = (cw - crop.imgW * fit) / 2; crop.oy = (ch - crop.imgH * fit) / 2;
      const sl = document.getElementById('zoomSlider');
      sl.min = fit * 0.25; sl.max = fit * 10; sl.value = fit;
      applyCropTransform();
      if (!crop.ready) { initCropEvents(); crop.ready = true; }
    });
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
  // Try lower quality if the output is too large for the server (512KB limit)
  let quality = 0.92;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (dataUrl.length > 480000) { dataUrl = canvas.toDataURL('image/jpeg', 0.75); }
  if (dataUrl.length > 480000) { dataUrl = canvas.toDataURL('image/jpeg', 0.6); }
  if (dataUrl.length > 512000) { showWarning('Image is too large even after compression. Try a smaller or simpler photo.'); document.getElementById('avatarUpload').value = ''; return; }
  pendingAvatarData = dataUrl;
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

function checkTemplateName() {
  const name = document.getElementById('newName')?.value.trim() || '';
  const norm = name.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
  const isTemplate = knownTemplateAliases.some(alias => norm === alias || norm.includes(alias));
  const resetBtn = document.getElementById('personaResetBtn');
  if (resetBtn) resetBtn.style.display = isTemplate ? 'inline-flex' : 'none';
}

function resetToTemplate() {
  document.getElementById('newPrompt').value = '';
  document.getElementById('newGreeting').value = '';
  updateCount('newGreeting','greetingCount',4096);
  showWarning('Persona cleared — built-in lore will be applied automatically when you save.', 5000);
}

function autoGeneratePersonaOnNameBlur() {
  if (!templatesLoaded) return; // templates not yet fetched — skip to avoid matching wrong universe
  const name = document.getElementById('newName')?.value.trim() || '';
  if (name.length < 2) return;
  const promptField = document.getElementById('newPrompt');
  if (!promptField || promptField.value.trim()) return;
  const norm = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const isTemplate = knownTemplateAliases.some(a => norm === a || norm.includes(a));
  if (isTemplate) return;
  generatePersona();
}

async function generatePersona() {
  const name = document.getElementById('newName').value.trim();
  if (!name) { alert('Enter a character name first.'); return; }
  const tagline = document.getElementById('newTagline').value.trim();
  const desc = document.getElementById('newDesc').value.trim();
  const btn = document.getElementById('personaGenBtn');
  const ta = document.getElementById('newPrompt');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const res = await fetch('/api/generate-persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, tagline, description: desc })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    ta.value = data.persona;
  } catch (err) {
    alert('Could not generate persona: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Auto-generate';
  }
}

async function createCharacter(e) {
  e.preventDefault();
  const name = document.getElementById('newName').value.trim();
  const tagline = document.getElementById('newTagline').value.trim();
  const desc = document.getElementById('newDesc').value.trim();
  const greeting = document.getElementById('newGreeting').value.trim();
  let prompt = document.getElementById('newPrompt').value.trim();
  const color = (document.getElementById('newColor').value || '#7c3aed').trim();
  const editingId = document.getElementById('newName').dataset.editingId;
  const id = editingId || 'custom_' + Date.now();

  if (!name) { alert('Character name is required'); return; }

  const submitBtn = document.querySelector('.btn-submit');
  submitBtn.disabled = true;

  // Check if name matches a built-in template — if so, server handles persona, skip auto-gen
  const nameMatchesTemplate = !editingId && knownTemplateAliases.some(alias =>
    name.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().includes(alias)
  );

  if (!prompt && !nameMatchesTemplate) {
    submitBtn.textContent = 'Generating persona…';
    try {
      const genRes = await fetch('/api/generate-persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tagline, description: desc })
      });
      if (genRes.ok) {
        const genData = await genRes.json();
        prompt = genData.persona || `You are ${name}.${desc ? ' ' + desc : ''}`;
        document.getElementById('newPrompt').value = prompt;
      }
    } catch (_) {}
    if (!prompt) prompt = `You are ${name}.${desc ? ' ' + desc : ''}`;
  }
  // For template characters with no custom prompt, send a placeholder — server will override
  if (!prompt) prompt = `You are ${name}.`;

  submitBtn.textContent = 'Saving…';

  const creatorName = currentUser?.name || localStorage.getItem('cm_creator_name') || '@you';
  const char = {
    id, name, tagline, creatorName,
    description: desc,
    color, accentColor: color,
    tags: [],
    image: pendingAvatarData || (editingId ? characters.find(c=>c.id===editingId)?.image : null) || null,
    greeting: greeting || null,
    greetingMode: getGreetingMode(),
    systemPrompt: prompt,
    interactions: editingId ? (characters.find(c=>c.id===editingId)?.interactions || 0) : 0
  };

  try {
    const method = editingId ? 'PUT' : 'POST';
    const url = editingId ? `/api/characters/${editingId}` : '/api/characters';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(char)
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Save failed'); }

    await loadCharacters();
    e.target.reset();
    pendingAvatarData = null;
    setGreetingMode('fixed');
    document.getElementById('newName').dataset.editingId = '';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Character';
    initGradientPicker('#7c3aed');
    document.getElementById('avatarPreview').innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;opacity:0.3"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
    ['nameCount','taglineCount','descCount','greetingCount'].forEach(cid => { const el = document.getElementById(cid); if(el) el.textContent = '0'; });
    renderHome(); renderDiscover();
    openChat(id);
  } catch (err) {
    alert('Failed to save character: ' + err.message);
    submitBtn.textContent = editingId ? 'Save Changes' : 'Create Character';
    submitBtn.disabled = false;
  }
}

function editCharacter(id) {
  const c = characters.find(x => x.id === id);
  if (!c) return;
  // Set pendingAvatarData BEFORE showCreate (which clears it), so existing image is preserved
  pendingAvatarData = c.image || null;
  showCreate();
  document.getElementById('newName').value = c.name;
  document.getElementById('newTagline').value = c.tagline || '';
  document.getElementById('newDesc').value = c.description || '';
  document.getElementById('newGreeting').value = c.greeting || '';
  document.getElementById('newPrompt').value = c.systemPrompt || '';
  document.getElementById('newName').dataset.editingId = id;
  document.querySelector('.btn-submit').textContent = 'Save Changes';
  setGreetingMode(c.greetingMode || 'fixed');
  if (c.image) {
    document.getElementById('avatarPreview').innerHTML = `<img src="${c.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    pendingAvatarData = c.image;
  }
  requestAnimationFrame(() => initGradientPicker(c.color || '#7c3aed'));
}

async function deleteCharacter(id) {
  const c = characters.find(x => x.id === id);
  if (!c || !confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/characters/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
    characters = characters.filter(x => x.id !== id);
    if (currentChar?.id === id) { currentChar = null; showHome(); }
    renderSidebarChats(); renderHome(); renderDiscover();
  } catch (err) { alert('Delete failed: ' + err.message); }
}

// ── Seasonal / birthday events ────────────────────────────────────────────────
function checkSeasonalEvent() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();

  const EVENTS = [
    {
      name: 'birthday',
      check: (m, d) => m === 9 && d === 27,
    },
    {
      name: 'halloween',
      check: (m, d) => m === 10 && d >= 25,
      emojis: ['🎃','👻','🕷️','🦇','🕸️','💀'],
      count: 22,
      banner: "👻 Happy Halloween from character.mind!",
      accent: '#ff6a00',
    },
    {
      name: 'christmas',
      check: (m, d) => m === 12 && d >= 20 && d <= 26,
      emojis: ['❄️','🎄','🎅','⭐','🎁','🔔'],
      count: 25,
      banner: "🎄 Merry Christmas from character.mind!",
      accent: '#2d8f4e',
    },
    {
      name: 'newyear',
      check: (m, d) => (m === 12 && d === 31) || (m === 1 && d === 1),
      emojis: ['🎆','🥂','✨','🎇','🎊','⭐'],
      count: 30,
      banner: month === 1 ? "🎆 Happy New Year from character.mind!" : "🥂 New Year's Eve — see you on the other side!",
      accent: '#7c3aed',
    },
    {
      name: 'valentine',
      check: (m, d) => m === 2 && d === 14,
      emojis: ['❤️','💕','💘','🌹','💝','✨'],
      count: 20,
      banner: "💕 Happy Valentine's Day from character.mind!",
      accent: '#e03058',
    },
    {
      name: 'stpatrick',
      check: (m, d) => m === 3 && d === 17,
      emojis: ['☘️','🍀','🌈','🎩','💚','⭐'],
      count: 22,
      banner: "☘️ Happy St. Patrick's Day from character.mind!",
      accent: '#16a34a',
    },
    {
      name: 'easter',
      check: (m, d) => {
        const yr = new Date().getFullYear();
        const a=yr%19,b=Math.floor(yr/100),c=yr%100,dd=Math.floor(b/4),e=b%4;
        const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
        const h=(19*a+b-dd-g+15)%30,ii=Math.floor(c/4),k=c%4;
        const l=(32+2*e+2*ii-h-k)%7,mm2=Math.floor((a+11*h+22*l)/451);
        const emon=Math.floor((h+l-7*mm2+114)/31),eday=((h+l-7*mm2+114)%31)+1;
        const diff=(new Date(yr,m-1,d)-new Date(yr,emon-1,eday))/864e5;
        return diff>=0 && diff<=1;
      },
      emojis: ['🐰','🥚','🌸','🐣','🌷','✨'],
      count: 22,
      banner: "🐣 Happy Easter from character.mind!",
      accent: '#ec4899',
    },
    {
      name: 'thanksgiving',
      check: (m, d) => {
        if (m !== 11) return false;
        const nov1 = new Date(new Date().getFullYear(), 10, 1);
        const t = 1 + ((4 - nov1.getDay() + 7) % 7) + 21;
        return d >= t && d <= t + 3;
      },
      emojis: ['🦃','🍂','🍁','🌽','🥧','🍎'],
      count: 22,
      banner: "🦃 Happy Thanksgiving from character.mind!",
      accent: '#b45309',
    },
    {
      name: 'july4',
      check: (m, d) => m === 7 && d === 4,
      emojis: ['🎆','🇺🇸','🎇','⭐','🎉','✨'],
      count: 25,
      banner: "🎆 Happy 4th of July from character.mind!",
      accent: '#1d4ed8',
    },
  ];

  const event = EVENTS.find(e => e.check(month, day));
  if (!event) return;

  if (event.name === 'birthday') {
    runBirthdayEvent();
    return;
  }

  spawnParticles(event.emojis, event.count);
  if (event.accent) setAccentOverride(event.accent);
  setTimeout(() => transformLogoForEvent(event.name), 500);
  setTimeout(() => showEventBanner(event.banner, event.name), 1200);
}

function runBirthdayEvent() {
  spawnBirthdayConfetti();
  setTimeout(() => transformLogoForEvent('birthday'), 500);
  setTimeout(showBirthdayBanner, 1800);
}

function spawnBirthdayConfetti() {
  const colors = ['#FFD700','#FF6B8A','#A78BFA','#34D399','#60A5FA','#F97316','#EC4899','#FBBF24','#F43F5E','#38BDF8'];
  const container = document.createElement('div');
  container.id = 'seasonal-particles';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  // CSS confetti: colored rectangles and circles
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('div');
    const isCircle = Math.random() > 0.55;
    const w = 7 + Math.random() * 8;
    const h = isCircle ? w : 3 + Math.random() * 7;
    el.className = 'confetti-piece';
    el.style.cssText = [
      `--color:${colors[Math.floor(Math.random() * colors.length)]}`,
      `--w:${w.toFixed(1)}px`,
      `--h:${h.toFixed(1)}px`,
      `--left:${(Math.random() * 102 - 1).toFixed(1)}vw`,
      `--radius:${isCircle ? '50%' : '2px'}`,
      `--duration:${(4 + Math.random() * 7).toFixed(2)}s`,
      `--delay:${(Math.random() * 9).toFixed(2)}s`,
      `--spin:${Math.round(Math.random() * 900 - 450)}deg`,
    ].join(';');
    container.appendChild(el);
  }

  // Emoji particles
  const emojis = ['🎂','🎉','🎊','🥳','🎈','✨','🎁','🎀','🪄','⭐'];
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('span');
    p.className = 'season-particle';
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    p.style.cssText = [
      `left:${Math.random() * 100}vw`,
      `font-size:${18 + Math.random() * 22}px`,
      `animation-delay:${(Math.random() * 8).toFixed(2)}s`,
      `animation-duration:${(6 + Math.random() * 8).toFixed(2)}s`,
      `opacity:${0.75 + Math.random() * 0.25}`,
    ].join(';');
    container.appendChild(p);
  }
}

function transformLogoForEvent(eventName) {
  const T = {
    birthday: {
      iconText: '🕯️', iconCls: 'birthday-candle-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--birthday">🎂</span>' +
        'm<span class="season-i season-i--birthday-candle" aria-label="i">🕯️</span>nd',
    },
    halloween: {
      iconText: '🎃', iconCls: 'halloween-icon',
      logoHtml: () =>
        '<span class="season-c">🌙</span>hara<span class="season-c">🌙</span>ter' +
        '<span class="season-dot season-dot--halloween">💀</span>' +
        'm<span class="season-i season-i--ghost" aria-label="i">👻</span>nd',
    },
    christmas: {
      iconText: '⭐', iconCls: 'christmas-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--christmas">❄️</span>' +
        'm<span class="season-i season-i--candle season-i--xmas" aria-label="i">' +
          '<span class="season-i-top">🔥</span>' +
          '<span class="season-i-stick season-i-stick--xmas"></span>' +
        '</span>nd',
    },
    newyear: {
      iconText: '🎆', iconCls: 'newyear-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--newyear">✨</span>' +
        'm<span class="season-i season-i--champagne" aria-label="i">🥂</span>nd',
    },
    valentine: {
      iconText: '💝', iconCls: 'valentine-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--valentine">❤️</span>' +
        'm<span class="season-i season-i--rose" aria-label="i">🌹</span>nd',
    },
    stpatrick: {
      iconText: '🌈', iconCls: 'stpatrick-icon',
      logoHtml: () =>
        '<span class="season-c">☘️</span>hara<span class="season-c">☘️</span>ter' +
        '<span class="season-dot season-dot--stpatrick">🍀</span>' +
        'm<span class="season-i season-i--tophat" aria-label="i">🎩</span>nd',
    },
    easter: {
      iconText: '🐰', iconCls: 'easter-icon',
      logoHtml: () =>
        'charact<span class="season-e">🥚</span>r' +
        '<span class="season-dot season-dot--easter">🌸</span>' +
        'm<span class="season-i season-i--tulip" aria-label="i">🌷</span>nd',
    },
    thanksgiving: {
      iconText: '🦃', iconCls: 'thanksgiving-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--thanksgiving">🍂</span>' +
        'm<span class="season-i season-i--corn" aria-label="i">🌽</span>nd',
    },
    july4: {
      iconText: '🎆', iconCls: 'july4-icon',
      logoHtml: () =>
        'character' +
        '<span class="season-dot season-dot--july4">⭐</span>' +
        'm<span class="season-i season-i--sparkler" aria-label="i">🎇</span>nd',
    },
  };

  const t = T[eventName];
  if (!t) return;

  document.querySelectorAll('.logo-icon').forEach(el => {
    el.textContent = t.iconText;
    el.classList.add(t.iconCls);
  });
  document.querySelectorAll('.logo-text').forEach(el => {
    if (el.textContent.trim() === 'character.mind') {
      el.innerHTML = t.logoHtml();
    }
  });
}

function showBirthdayBanner() {
  if (document.getElementById('event-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'event-banner';
  banner.className = 'event-banner event-banner--birthday';
  banner.innerHTML = `
    <div class="birthday-banner-candles" aria-hidden="true">🕯️🕯️🕯️</div>
    <div class="birthday-banner-text">
      <strong>Happy Birthday, character.mind!</strong>
      <span>One year of bringing characters to life 🎊</span>
    </div>
    <button onclick="this.closest('.event-banner').remove()" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 15000);
}

function spawnParticles(emojis, count) {
  const container = document.createElement('div');
  container.id = 'seasonal-particles';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'season-particle';
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    p.style.cssText = [
      `left:${Math.random() * 100}vw`,
      `font-size:${16 + Math.random() * 22}px`,
      `animation-delay:${(Math.random() * 8).toFixed(2)}s`,
      `animation-duration:${(6 + Math.random() * 8).toFixed(2)}s`,
      `opacity:${0.7 + Math.random() * 0.3}`,
    ].join(';');
    container.appendChild(p);
  }
}

function setAccentOverride(color) {
  document.documentElement.style.setProperty('--accent', color);
}

function showEventBanner(msg, eventName) {
  if (document.getElementById('event-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'event-banner';
  banner.className = `event-banner event-banner--${eventName}`;
  banner.innerHTML = `
    <span>${msg}</span>
    <button onclick="this.closest('.event-banner').remove()" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 10000);
}
