/* ============================================================
   YouTube O'zbek Transkript — Frontend App
   ============================================================ */

// State
let player = null;
let playerReady = false;
let ytApiReady = false;
let segments = [];
let currentActiveIndex = -1;
let showOriginal = false;
let searchQuery = '';
let syncInterval = null;
let lastUrl = '';
let videoId = null;
let isLoading = false;
let currentEvtSource = null;
let currentUser = null;
let lastUsageData = null;

// DOM refs
const urlInput      = document.getElementById('urlInput');
const loadBtn       = document.getElementById('loadBtn');
const clearBtn      = document.getElementById('clearBtn');
const welcome       = document.getElementById('welcome');
const workspace     = document.getElementById('workspace');
const segmentsEl    = document.getElementById('segments');
const loadingBar    = document.getElementById('loadingBar');
const loadingFill   = document.getElementById('loadingFill');
const loadingStatus = document.getElementById('loadingStatus');
const whisperBadge  = document.getElementById('whisperBadge');
const sourceBadge   = document.getElementById('sourceBadge');
const errorState    = document.getElementById('errorState');
const errorMsg      = document.getElementById('errorMsg');
const retryBtn      = document.getElementById('retryBtn');
const toggleLangBtn = document.getElementById('toggleLang');
const copyBtn       = document.getElementById('copyBtn');
const downloadBtn   = document.getElementById('downloadBtn');
const searchToggle  = document.getElementById('searchToggle');
const searchBar     = document.getElementById('searchBar');
const searchInput   = document.getElementById('searchInput');
const searchCount   = document.getElementById('searchCount');
const segmentCount  = document.getElementById('segmentCount');
const videoTitle    = document.getElementById('videoTitle');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl   = document.getElementById('totalTime');
const muteBtn       = document.getElementById('muteBtn');
const subtitleOverlay = document.getElementById('subtitleOverlay');
// Persistent span inside overlay — avoids repeated DOM creation
const subtitleSpan = (() => {
  const s = document.createElement('span');
  subtitleOverlay.appendChild(s);
  return s;
})();

/* ============================================================
   YouTube IFrame API
   ============================================================ */
window.onYouTubeIframeAPIReady = function () { ytApiReady = true; };

function createPlayer(vid) {
  if (player) { playerReady = false; player.loadVideoById(vid); return; }
  player = new YT.Player('ytPlayer', {
    videoId: vid,
    playerVars: { autoplay: 0, modestbranding: 1, rel: 0, cc_load_policy: 0 },
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange },
  });
}

function onPlayerReady(e) {
  playerReady = true;
  totalTimeEl.textContent = formatTime(e.target.getDuration());
  startSyncLoop();
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) {
    startSyncLoop();
  } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) {
    // Keep interval alive for time display, just don't waste CPU on fast ticks
    // (interval is lightweight, but stop overlay on ended)
    if (e.data === YT.PlayerState.ENDED) {
      subtitleSpan.textContent = '';
      subtitleOverlay.classList.remove('visible');
    }
  }
}

function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(syncTranscript, 100);
}

/* ============================================================
   Video — Transcript Sync
   ============================================================ */
function syncTranscript() {
  if (!playerReady || !player || typeof player.getCurrentTime !== 'function') return;
  const cur = player.getCurrentTime();
  currentTimeEl.textContent = formatTime(cur);
  if (!segments.length) return;

  // List highlight: last segment whose start <= cur
  let newIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i]) continue;
    if (cur >= segments[i].offset / 1000) { newIdx = i; break; }
  }

  if (newIdx !== currentActiveIndex) {
    const prev = document.querySelector(`.segment[data-index="${currentActiveIndex}"]`);
    if (prev) prev.classList.remove('active');
    if (newIdx >= 0) {
      const next = document.querySelector(`.segment[data-index="${newIdx}"]`);
      if (next) {
        next.classList.add('active');
        // Only scroll if not visible
        const rect = next.getBoundingClientRect();
        const panelRect = segmentsEl.getBoundingClientRect();
        const isVisible = rect.top >= panelRect.top && rect.bottom <= panelRect.bottom;
        if (!isVisible) next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    currentActiveIndex = newIdx;
  }

  // Overlay: strict time range — show only while start <= cur < end
  if (newIdx >= 0) {
    const seg = segments[newIdx];
    const start = seg.offset / 1000;
    const end   = start + seg.duration / 1000;
    if (cur >= start && cur < end) {
      if (subtitleSpan.textContent !== seg.translatedText) {
        subtitleSpan.textContent = seg.translatedText;
        subtitleOverlay.classList.add('visible');
      }
    } else {
      if (subtitleSpan.textContent) {
        subtitleSpan.textContent = '';
        subtitleOverlay.classList.remove('visible');
      }
    }
  } else {
    subtitleSpan.textContent = '';
    subtitleOverlay.classList.remove('visible');
  }
}

/* ============================================================
   Load Video + Transcript
   ============================================================ */
async function load() {
  const url = urlInput.value.trim();
  if (!url) return;

  if (currentEvtSource) { currentEvtSource.close(); currentEvtSource = null; }
  isLoading = false;

  const vid = extractVideoId(url);
  if (!vid) { showToast("Noto'g'ri YouTube URL formati"); urlInput.focus(); return; }

  isLoading = true;
  videoId = vid;
  lastUrl = url;
  segments = [];
  currentActiveIndex = -1;

  setLoadingState(true);
  showWorkspace();
  resetTranscriptPanel();

  if (ytApiReady) {
    createPlayer(vid);
  } else {
    let attempts = 0;
    const wait = setInterval(() => {
      attempts++;
      if (ytApiReady) { clearInterval(wait); createPlayer(vid); }
      else if (attempts > 80) clearInterval(wait); // 8 soniya kutib to'xtatamiz
    }, 100);
  }

  fetchVideoInfo(url);
  streamTranscript(url);
}

function extractVideoId(url) {
  url = (url || '').trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\n?#\s]+)/,
    /(?:youtu\.be\/)([^&\n?#\s]+)/,
    /(?:youtube\.com\/embed\/)([^&\n?#\s]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

async function fetchVideoInfo(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`/api/video-info?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
    const d = await r.json();
    if (d.title) {
      videoTitle.textContent = d.title;
      document.title = `${d.title} — O'zbek Transkript`;
    }
  } catch {
    videoTitle.textContent = 'YouTube Video';
  }
}

function streamTranscript(url) {
  const evtSource = new EventSource(`/api/transcript?url=${encodeURIComponent(url)}`);
  currentEvtSource = evtSource;
  let total = 0;
  let loaded = 0;

  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'status') {
      loadingStatus.textContent = msg.message;
    }

    if (msg.type === 'whisper_mode') {
      whisperBadge.style.display = 'flex';
      loadingFill.style.background = 'linear-gradient(90deg, #ce93d8, #7e57c2)';
    }

    if (msg.type === 'engine') {
      loadingStatus.textContent = `${msg.engine} tarjima qilyabdi...`;
      loadingFill.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
    }

    if (msg.type === 'start') {
      total = msg.total;
      segmentCount.textContent = `0 / ${total}`;

      const sourceLabel = msg.source === 'whisper' ? '🤖 Grgitton AI' : '📝 YouTube subtitrlar';
      const langLabel = msg.lang && msg.lang !== 'uz' && msg.lang !== 'auto'
        ? msg.lang.toUpperCase() : '';
      sourceBadge.textContent = '';
      const labelEl = document.createElement('span');
      labelEl.textContent = sourceLabel;
      sourceBadge.appendChild(labelEl);
      if (langLabel) {
        const tagEl = document.createElement('span');
        tagEl.className = 'lang-tag';
        tagEl.textContent = `${langLabel} → O'zbekcha`;
        sourceBadge.appendChild(tagEl);
      }
      sourceBadge.style.display = 'flex';
      loadingStatus.textContent = msg.needsTranslation
        ? `Tarjima qilinmoqda (${total} segment)...`
        : `O'zbek subtitrlar yuklanmoqda (${total} segment)...`;
      addSkeletons(Math.min(total, 8));
    }

    if (msg.type === 'segment') {
      removeFirstSkeleton();
      const seg = {
        index: msg.index,
        offset: Math.max(0, msg.offset || 0),
        duration: Math.max(0, msg.duration || 0),
        originalText: msg.originalText || '',
        translatedText: msg.translatedText || '',
      };
      segments[msg.index] = seg;
      loaded++;
      appendSegment(seg);
      segmentCount.textContent = `${loaded} / ${total}`;
    }

    if (msg.type === 'progress') {
      const pct = total > 0 ? (msg.done / msg.total) * 100 : 0;
      loadingFill.style.width = `${pct}%`;
      loadingStatus.textContent = `Tarjima: ${msg.done} / ${msg.total} segment...`;
    }

    if (msg.type === 'done') {
      evtSource.close();
      currentEvtSource = null;
      setLoadingState(false);
      isLoading = false;
      loadingBar.style.display = 'none';
      const realCount = segments.filter(Boolean).length;
      segmentCount.textContent = `${realCount} segment`;
      showToast('Transkript tayyor!');
    }

    if (msg.type === 'rate_limit') {
      evtSource.close();
      currentEvtSource = null;
      isLoading = false;
      setLoadingState(false);
      loadingBar.style.display = 'none';
      showError(msg.message);
      updateUsageBar(msg.dailyUsed, msg.dailyLimit);
    }

    if (msg.type === 'usage') {
      updateUsageBar(msg.dailyUsed, msg.dailyLimit);
    }

    if (msg.type === 'error') {
      evtSource.close();
      currentEvtSource = null;
      isLoading = false;
      setLoadingState(false);
      loadingBar.style.display = 'none';
      showError(msg.message);
    }
  };

  evtSource.onerror = () => {
    if (isLoading) {
      evtSource.close();
      currentEvtSource = null;
      isLoading = false;
      setLoadingState(false);
      loadingBar.style.display = 'none';
      showError("Server bilan ulanishda xato yuz berdi");
    }
  };
}

// Sahifa yopilganda stream tozala
window.addEventListener('beforeunload', () => {
  if (currentEvtSource) { currentEvtSource.close(); }
  if (syncInterval) clearInterval(syncInterval);
});

/* ============================================================
   DOM Helpers
   ============================================================ */
function appendSegment(seg) {
  const div = document.createElement('div');
  div.className = 'segment';
  div.dataset.index = seg.index;
  div.dataset.translated = (seg.translatedText || '').toLowerCase();
  div.dataset.original   = (seg.originalText || '').toLowerCase();

  const timeDiv = document.createElement('div');
  timeDiv.className = 'segment-time';
  const timeTag = document.createElement('span');
  timeTag.className = 'time-tag';
  timeTag.textContent = formatTime(seg.offset / 1000);
  timeDiv.appendChild(timeTag);

  const textDiv = document.createElement('div');
  textDiv.className = 'segment-text';
  textDiv.textContent = seg.translatedText;

  const origDiv = document.createElement('div');
  origDiv.className = 'segment-original';
  origDiv.textContent = seg.originalText;

  div.appendChild(timeDiv);
  div.appendChild(textDiv);
  div.appendChild(origDiv);

  div.addEventListener('click', () => {
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(seg.offset / 1000, true);
      player.playVideo();
    }
  });

  segmentsEl.appendChild(div);
  if (searchQuery) applySearchToElement(div, searchQuery);
  if (showOriginal) div.classList.add('show-original');
}

function addSkeletons(n) {
  for (let i = 0; i < n; i++) {
    const div = document.createElement('div');
    div.className = 'skeleton';
    const t = document.createElement('div');
    t.className = 'skeleton-line skeleton-time';
    const tx = document.createElement('div');
    tx.className = 'skeleton-line skeleton-text';
    tx.style.width = `${70 + Math.random() * 25}%`;
    div.appendChild(t);
    div.appendChild(tx);
    segmentsEl.appendChild(div);
  }
}

function removeFirstSkeleton() {
  const sk = segmentsEl.querySelector('.skeleton');
  if (sk) sk.remove();
}

function resetTranscriptPanel() {
  segmentsEl.innerHTML = '';
  subtitleSpan.textContent = '';
  subtitleOverlay.classList.remove('visible');
  errorState.style.display = 'none';
  sourceBadge.style.display = 'none';
  sourceBadge.textContent = '';
  whisperBadge.style.display = 'none';
  loadingBar.style.display = 'block';
  loadingFill.style.width = '0%';
  loadingFill.style.background = 'linear-gradient(90deg, var(--red), var(--blue))';
  loadingStatus.textContent = 'Grgitton tahlil qilmoqda...';
  segmentCount.textContent = '—';
  currentTimeEl.textContent = '0:00';
  totalTimeEl.textContent = '0:00';
  videoTitle.textContent = 'Video yuklanmoqda...';
  document.title = "YouTube O'zbek Transkript";
}

function showWorkspace() {
  welcome.style.display = 'none';
  workspace.style.display = 'flex';
}

function setLoadingState(loading) {
  loadBtn.classList.toggle('loading', loading);
  loadBtn.disabled = loading;
  loadBtn.querySelector('.btn-text').textContent = loading ? 'Yuklanmoqda...' : 'Yuklash';
}

function showError(msg) {
  errorState.style.display = 'flex';
  errorMsg.textContent = msg;
  segmentsEl.innerHTML = '';
}

/* ============================================================
   Search
   ============================================================ */
function applySearch(query) {
  // Max 100 ta belgi — ReDoS himoyasi
  searchQuery = query.toLowerCase().trim().slice(0, 100);
  let matchCount = 0;
  segmentsEl.querySelectorAll('.segment').forEach(el => {
    const idx = el.dataset.index;
    const seg = segments[idx];
    if (!seg) return;
    if (!searchQuery) {
      el.classList.remove('hidden');
      el.querySelector('.segment-text').textContent = seg.translatedText;
      el.querySelector('.segment-original').textContent = seg.originalText;
    } else {
      const hit = el.dataset.translated.includes(searchQuery) || el.dataset.original.includes(searchQuery);
      el.classList.toggle('hidden', !hit);
      if (hit) { matchCount++; applySearchToElement(el, searchQuery); }
    }
  });
  searchCount.textContent = searchQuery ? `${matchCount} natija` : '';
}

function applySearchToElement(el, query) {
  const idx = el.dataset.index;
  const seg = segments[idx];
  if (!seg || !query) return;
  el.querySelector('.segment-text').innerHTML    = highlightText(escHtml(seg.translatedText), query);
  el.querySelector('.segment-original').innerHTML = highlightText(escHtml(seg.originalText), query);
}

function highlightText(text, query) {
  if (!query) return text;
  return text.replace(new RegExp(`(${escRegex(query)})`, 'gi'), '<mark class="highlight">$1</mark>');
}

/* ============================================================
   Download / Copy
   ============================================================ */
function buildTranscriptText() {
  return segments.filter(Boolean)
    .map(s => `[${formatTime((s.offset || 0) / 1000)}] ${s.translatedText || ''}`)
    .join('\n');
}

function downloadTranscript() {
  const text = buildTranscriptText();
  if (!text) { showToast("Hali transkript yo'q"); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `transkript-${videoId || 'video'}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Transkript yuklab olindi');
}

function copyTranscript() {
  const text = buildTranscriptText();
  if (!text) { showToast("Hali transkript yo'q"); return; }
  navigator.clipboard.writeText(text)
    .then(() => showToast('Transkript nusxalandi'))
    .catch(() => showToast('Nusxalash amalga oshmadi'));
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

/* ============================================================
   Utils
   ============================================================ */
function formatTime(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function updateUsageBar(used, limit) {
  lastUsageData = { used, limit };
  const el = document.getElementById('usageBar');
  if (!el || !limit) return;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const color = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  el.innerHTML = `
    <span class="usage-label">Bugungi so'rovlar: ${used}/${limit}</span>
    <div class="usage-track"><div class="usage-fill" style="width:${pct}%;background:${color}"></div></div>
  `;
  el.style.display = 'flex';
  // Refresh welcome screen stats if it's already been rendered
  const welcomeEl = document.getElementById('welcome');
  if (welcomeEl && welcomeEl.querySelector('.wt-content')) {
    const tier = currentUser === null ? 'guest' : (currentUser.isPremium ? 'premium' : 'free');
    renderWelcomeScreen(tier);
  }
}

async function loadUsage() {
  try {
    const res = await fetch('/api/usage');
    const data = await res.json();
    if (data.transcript) updateUsageBar(data.transcript.used, data.transcript.limit);
  } catch {}
}

function escHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ============================================================
   Event Listeners
   ============================================================ */
loadBtn.addEventListener('click', load);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
urlInput.addEventListener('input', () => clearBtn.classList.toggle('visible', urlInput.value.length > 0));
clearBtn.addEventListener('click', () => { urlInput.value = ''; clearBtn.classList.remove('visible'); urlInput.focus(); });

toggleLangBtn.addEventListener('click', () => {
  showOriginal = !showOriginal;
  toggleLangBtn.classList.toggle('active', showOriginal);
  toggleLangBtn.querySelector('span').textContent = showOriginal ? 'Tarjima' : 'Asl matn';
  document.querySelectorAll('.segment').forEach(el => el.classList.toggle('show-original', showOriginal));
});

searchToggle.addEventListener('click', () => {
  const vis = searchBar.style.display !== 'none';
  searchBar.style.display = vis ? 'none' : 'flex';
  searchToggle.classList.toggle('active', !vis);
  if (!vis) searchInput.focus();
  else { searchInput.value = ''; applySearch(''); }
});

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => applySearch(searchInput.value), 250);
});
copyBtn.addEventListener('click', copyTranscript);
downloadBtn.addEventListener('click', downloadTranscript);

retryBtn.addEventListener('click', () => {
  if (lastUrl) { urlInput.value = lastUrl; load(); }
});

muteBtn.addEventListener('click', () => {
  if (!player) return;
  if (player.isMuted()) {
    player.unMute();
    muteBtn.title = 'Ovozni o\'chirish';
    muteBtn.style.opacity = '1';
  } else {
    player.mute();
    muteBtn.title = 'Ovozni yoqish';
    muteBtn.style.opacity = '0.4';
  }
});

const fullscreenBtn = document.getElementById('fullscreenBtn');
const fsIconExpand = document.getElementById('fsIconExpand');
const fsIconCollapse = document.getElementById('fsIconCollapse');

fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    workspace.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  fsIconExpand.style.display = isFs ? 'none' : 'inline';
  fsIconCollapse.style.display = isFs ? 'inline' : 'none';
  fullscreenBtn.title = isFs ? 'To\'liq ekrandan chiqish' : 'To\'liq ekran (video + transkript)';
});

document.addEventListener('keydown', e => {
  if (e.target === urlInput || e.target === searchInput) return;
  if (e.code === 'Space' && player && playerReady) {
    e.preventDefault();
    player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
  }
});

/* ============================================================
   Auth & Landing
   ============================================================ */
async function initAuth() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('/api/me', { signal: ctrl.signal });
    const data = await res.json();

    if (!data.loggedIn) {
      document.getElementById('landingPage').style.display = 'block';
      document.getElementById('appContainer').style.display = 'none';
      document.getElementById('headerGuest').style.display = 'flex';
      document.getElementById('emailLoginForm').style.display = 'none';
      document.querySelector('.landing-tiers').style.display = 'flex';
      loadUsage();
      return;
    }
    showApp(data);  // loadUsage() is called inside showApp
  } catch {
    // Server yetib bormasa landing ko'rsat
    document.getElementById('landingPage').style.display = 'block';
    document.getElementById('headerGuest').style.display = 'flex';
  }
}

function showApp(data) {
  currentUser = data;
  lastUsageData = null;  // Stale anonymous data tozalanadi — to'g'ri tier limiti yuklanadi
  document.getElementById('landingPage').style.display = 'none';
  document.getElementById('appContainer').style.display = 'block';
  document.getElementById('headerGuest').style.display = 'none';
  document.getElementById('headerUser').style.display = 'flex';

  // Avatar: initials
  const avatarEl = document.getElementById('userAvatar');
  const initial = (data.name || data.email || '?')[0].toUpperCase();
  avatarEl.textContent = initial;
  avatarEl.setAttribute('data-initial', initial);

  document.getElementById('userDropdownName').textContent = data.name || data.email;
  document.getElementById('userDropdownEmail').textContent = data.email;
  document.getElementById('userDropdownTier').textContent = data.isPremium ? '⚡ Premium' : 'Bepul tarif';

  const upgradeBtn = document.getElementById('upgradeBtn');
  if (data.isPremium) {
    upgradeBtn.textContent = '⚡ Premium faol';
    upgradeBtn.classList.add('premium-active');
  } else {
    upgradeBtn.textContent = '⚡ Premium';
  }

  document.getElementById('sharePostBtn').style.display = data.isPremium ? 'flex' : 'none';
  renderWelcomeScreen(data.isPremium ? 'premium' : 'free');
  loadUsage();
  urlInput.focus();
}

// Email login
async function emailLogin(email) {
  const btn = document.getElementById('emailLoginBtn');
  const errEl = document.getElementById('emailLoginError');
  btn.disabled = true;
  btn.textContent = 'Kirilmoqda...';
  errEl.textContent = '';

  try {
    const res = await fetch('/auth/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Xato yuz berdi';
      btn.disabled = false;
      btn.textContent = 'Kirish';
      return;
    }
    const me = await (await fetch('/api/me')).json();
    if (me.loggedIn) showApp(me);
    else { errEl.textContent = 'Kirish amalga oshmadi'; btn.disabled = false; btn.textContent = 'Kirish'; }
  } catch {
    errEl.textContent = 'Server bilan ulanishda xato';
    btn.disabled = false;
    btn.textContent = 'Kirish';
  }
}

document.getElementById('emailLoginBtn').addEventListener('click', () => {
  const email = document.getElementById('emailInput').value.trim();
  if (email) emailLogin(email);
});

document.getElementById('emailInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const email = e.target.value.trim();
    if (email) emailLogin(email);
  }
});

document.getElementById('headerLoginBtn')?.addEventListener('click', () => {
  showLoginForm("Kirish / Ro'yxatdan o'tish");
});

// Landing tugmalari
function showLoginForm(title = "Ro'yxatdan o'tish") {
  document.getElementById('loginFormTitle').textContent = title;
  document.getElementById('emailLoginForm').style.display = 'flex';
  document.querySelector('.landing-tiers').style.display = 'none';
  setTimeout(() => document.getElementById('emailInput').focus(), 50);
}

function hideLoginForm() {
  document.getElementById('emailLoginForm').style.display = 'none';
  document.querySelector('.landing-tiers').style.display = 'flex';
}

document.getElementById('showLoginBtn')?.addEventListener('click', () => {
  showLoginForm("Bepul ro'yxatdan o'ting");
});

document.getElementById('showLoginPremiumBtn')?.addEventListener('click', () => {
  showLoginForm("Premium boshlash uchun kiring");
});

document.getElementById('backToTiersBtn')?.addEventListener('click', hideLoginForm);

document.getElementById('tryWithoutLoginBtn')?.addEventListener('click', () => {
  document.getElementById('landingPage').style.display = 'none';
  document.getElementById('appContainer').style.display = 'block';
  document.getElementById('headerGuest').style.display = 'flex';
  document.getElementById('headerUser').style.display = 'none';
  document.getElementById('sharePostBtn').style.display = 'none';
  renderWelcomeScreen('guest');
  loadUsage();
  urlInput.focus();
});

// Avatar dropdown
document.getElementById('userAvatar').addEventListener('click', e => {
  e.stopPropagation();
  const dd = document.getElementById('userDropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  if (menu && !menu.contains(e.target))
    document.getElementById('userDropdown').style.display = 'none';
});

// Logout
document.getElementById('userDropdown').addEventListener('click', async e => {
  if (e.target.classList.contains('user-dropdown-logout')) {
    await fetch('/auth/logout', { method: 'POST' });
    location.reload();
  }
});

// Upgrade modal
function openUpgradeModal() {
  document.getElementById('upgradeDefault').style.display = 'block';
  document.getElementById('upgradeSuccess').style.display = 'none';
  const btn = document.getElementById('requestUpgradeBtn');
  if (btn) { btn.disabled = false; btn.textContent = "⚡ Premium so'rov yuborish"; }
  document.getElementById('upgradeModal').style.display = 'flex';
}

document.getElementById('upgradeBtn').addEventListener('click', openUpgradeModal);

document.getElementById('modalClose').addEventListener('click', () => {
  document.getElementById('upgradeModal').style.display = 'none';
});

document.getElementById('upgradeModal').addEventListener('click', e => {
  if (e.target === document.getElementById('upgradeModal'))
    document.getElementById('upgradeModal').style.display = 'none';
});

document.getElementById('requestUpgradeBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('requestUpgradeBtn');
  btn.disabled = true;
  btn.textContent = 'Yuborilmoqda...';
  try {
    const res = await fetch('/api/request-upgrade', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (data.already) {
        showToast('Siz allaqachon Premium foydalanuvchisiz!');
        document.getElementById('upgradeModal').style.display = 'none';
        return;
      }
      document.getElementById('upgradeDefault').style.display = 'none';
      document.getElementById('upgradeSuccess').style.display = 'block';
    } else {
      showToast(data.error || "Xato yuz berdi");
      btn.disabled = false;
      btn.textContent = "⚡ Premium so'rov yuborish";
    }
  } catch {
    showToast("Tarmoq xatosi");
    btn.disabled = false;
    btn.textContent = "⚡ Premium so'rov yuborish";
  }
});

document.getElementById('upgradeSuccessClose')?.addEventListener('click', () => {
  document.getElementById('upgradeModal').style.display = 'none';
});

/* ============================================================
   Social Post Modal
   ============================================================ */
let lastGeneratedPlatform = null;

document.getElementById('sharePostBtn').addEventListener('click', () => {
  if (!lastUrl) { showToast("Avval video yuklang"); return; }
  const modal = document.getElementById('socialPostModal');
  document.getElementById('socialPostResult').style.display = 'none';
  document.getElementById('socialPostLoading').style.display = 'none';
  document.getElementById('socialPlatforms').style.display = 'grid';
  modal.style.display = 'flex';
});

document.getElementById('socialModalClose').addEventListener('click', () => {
  document.getElementById('socialPostModal').style.display = 'none';
});

document.getElementById('socialPostModal').addEventListener('click', e => {
  if (e.target === document.getElementById('socialPostModal'))
    document.getElementById('socialPostModal').style.display = 'none';
});

document.getElementById('socialPlatforms').addEventListener('click', async e => {
  const btn = e.target.closest('.platform-btn');
  if (!btn) return;
  const platform = btn.dataset.platform;
  lastGeneratedPlatform = platform;
  await generatePost(platform);
});

document.getElementById('copyPostBtn').addEventListener('click', () => {
  const text = document.getElementById('postResultText').value;
  navigator.clipboard.writeText(text).then(() => showToast('Nusxa olindi'));
});

document.getElementById('regeneratePostBtn').addEventListener('click', async () => {
  if (lastGeneratedPlatform) await generatePost(lastGeneratedPlatform);
});

async function generatePost(platform) {
  const platforms = document.getElementById('socialPlatforms');
  const loading = document.getElementById('socialPostLoading');
  const result = document.getElementById('socialPostResult');

  platforms.style.display = 'none';
  result.style.display = 'none';
  loading.style.display = 'flex';

  try {
    const res = await fetch('/api/generate-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: lastUrl, platform }),
    });
    const data = await res.json();

    if (!res.ok) { showToast(data.error || 'Xato'); platforms.style.display = 'grid'; loading.style.display = 'none'; return; }

    document.getElementById('postPlatformName').textContent = '✨ ' + data.platform + ' uchun post';
    document.getElementById('postResultText').value = data.post;
    loading.style.display = 'none';
    result.style.display = 'block';
    platforms.style.display = 'grid';
  } catch {
    showToast('Tarmoq xatosi');
    platforms.style.display = 'grid';
    loading.style.display = 'none';
  }
}

/* ============================================================
   Welcome Screen — Tier-specific content
   ============================================================ */
function renderWelcomeScreen(tier) {
  const el = document.getElementById('welcome');
  if (!el) return;

  const used = lastUsageData ? lastUsageData.used : 0;
  const defaultLimit = tier === 'guest' ? 2 : tier === 'free' ? 5 : 50;
  const limit = lastUsageData ? lastUsageData.limit : defaultLimit;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const barColor = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  const userDisplay = currentUser
    ? escHtml((currentUser.name || currentUser.email || '').substring(0, 32))
    : '';

  let html = '';

  if (tier === 'guest') {
    html = `<div class="wt-content">
      <div class="wt-header">
        <div class="wt-icon">👤</div>
        <h2 class="wt-title">Mehmon sifatida kirgansiz</h2>
        <p class="wt-sub">YouTube havolasini yuqoriga kiriting va tarjimani boshlang</p>
      </div>
      <div class="wt-usage-card">
        <div class="wt-usage-row">
          <span class="wt-usage-lbl">Bugungi so'rovlar</span>
          <span class="wt-usage-num">${used} / ${limit}</span>
        </div>
        <div class="wt-bar-track"><div class="wt-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      </div>
      <div class="wt-limits-list">
        <div class="wt-limit-row"><span class="wt-no-x">✗</span> Saqlash imkoni yo'q</div>
        <div class="wt-limit-row"><span class="wt-no-x">✗</span> AI post yaratish yo'q</div>
        <div class="wt-limit-row"><span class="wt-no-x">✗</span> Yuklab olish yo'q</div>
      </div>
      <div class="wt-cta-block">
        <p class="wt-cta-hint">Ro'yxatdan o'tsangiz — kuniga <strong>5 ta</strong> video bepul!</p>
        <button class="wt-btn wt-btn-free" id="welcomeRegisterBtn">Bepul ro'yxatdan o'tish</button>
        <button class="wt-btn wt-btn-premium" id="welcomePremiumBtn">⚡ Premium boshlash — $5/oy</button>
      </div>
    </div>`;
  } else if (tier === 'free') {
    html = `<div class="wt-content">
      <div class="wt-header">
        <div class="wt-icon">🆓</div>
        <h2 class="wt-title">Bepul tarif faol</h2>
        ${userDisplay ? `<p class="wt-sub">${userDisplay}</p>` : ''}
      </div>
      <div class="wt-usage-card">
        <div class="wt-usage-row">
          <span class="wt-usage-lbl">Bugungi so'rovlar</span>
          <span class="wt-usage-num">${used} / ${limit}</span>
        </div>
        <div class="wt-bar-track"><div class="wt-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      </div>
      <div class="wt-upgrade-card">
        <div class="wt-upgrade-hd">⚡ Premium'ga o'ting</div>
        <ul class="wt-upgrade-ul">
          <li>Kuniga <strong>50 ta</strong> video — 10× ko'p</li>
          <li>Grgitton AI — aniqroq tarjima</li>
          <li>Kuniga <strong>20 ta</strong> AI post</li>
          <li>Instagram, Telegram, LinkedIn va boshqalar</li>
        </ul>
        <button class="wt-btn wt-btn-premium" id="welcomeUpgradeBtn">⚡ Premium boshlash — $5/oy</button>
      </div>
    </div>`;
  } else {
    html = `<div class="wt-content wt-premium-content">
      <div class="wt-header">
        <div class="wt-icon">⚡</div>
        <h2 class="wt-title wt-title-premium">Premium faol</h2>
        ${userDisplay ? `<p class="wt-sub">${userDisplay}</p>` : ''}
      </div>
      <div class="wt-stats-row">
        <div class="wt-stat">
          <div class="wt-stat-n" style="color:#22c55e">${used}</div>
          <div class="wt-stat-l">Bugun ishlatildi</div>
        </div>
        <div class="wt-stat">
          <div class="wt-stat-n">${limit}</div>
          <div class="wt-stat-l">Kunlik limit</div>
        </div>
        <div class="wt-stat">
          <div class="wt-stat-n" style="color:#f59e0b">20</div>
          <div class="wt-stat-l">AI post / kun</div>
        </div>
      </div>
      <div class="wt-features-grid">
        <div class="wt-feat">🎯 Grgitton AI tarjima</div>
        <div class="wt-feat">📱 6 platforma posti</div>
        <div class="wt-feat">📥 Transkript yuklab olish</div>
        <div class="wt-feat">🔍 Matn qidirish</div>
        <div class="wt-feat">🎬 Real vaqt subtitlar</div>
        <div class="wt-feat">🌐 Har qanday tildan</div>
      </div>
      <p class="wt-tip">💡 Yuqoriga YouTube havolasini kiriting va tarjimani boshlang</p>
    </div>`;
  }

  el.innerHTML = html;

  document.getElementById('welcomeRegisterBtn')?.addEventListener('click', () => {
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('landingPage').style.display = 'block';
    document.getElementById('headerGuest').style.display = 'flex';
    document.getElementById('headerUser').style.display = 'none';
    document.querySelector('.landing-tiers').style.display = 'flex';
    document.getElementById('emailLoginForm').style.display = 'none';
    showLoginForm("Bepul ro'yxatdan o'ting");
  });

  document.getElementById('welcomePremiumBtn')?.addEventListener('click', () => {
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('landingPage').style.display = 'block';
    document.getElementById('headerGuest').style.display = 'flex';
    document.getElementById('headerUser').style.display = 'none';
    document.querySelector('.landing-tiers').style.display = 'flex';
    document.getElementById('emailLoginForm').style.display = 'none';
    showLoginForm("Premium boshlash uchun kiring");
  });

  document.getElementById('welcomeUpgradeBtn')?.addEventListener('click', openUpgradeModal);
}

initAuth();
