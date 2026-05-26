/* ============================================================
   YouTube O'zbek Transkript — Frontend App
   ============================================================ */

// State
let player = null;
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

// DOM refs
const urlInput    = document.getElementById('urlInput');
const loadBtn     = document.getElementById('loadBtn');
const clearBtn    = document.getElementById('clearBtn');
const welcome     = document.getElementById('welcome');
const workspace   = document.getElementById('workspace');
const segmentsEl  = document.getElementById('segments');
const loadingBar  = document.getElementById('loadingBar');
const loadingFill = document.getElementById('loadingFill');
const loadingStatus = document.getElementById('loadingStatus');
const whisperBadge  = document.getElementById('whisperBadge');
const sourceBadge   = document.getElementById('sourceBadge');
const errorState  = document.getElementById('errorState');
const errorMsg    = document.getElementById('errorMsg');
const retryBtn    = document.getElementById('retryBtn');
const toggleLangBtn = document.getElementById('toggleLang');
const copyBtn     = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const searchToggle  = document.getElementById('searchToggle');
const searchBar   = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const segmentCount  = document.getElementById('segmentCount');
const videoTitle  = document.getElementById('videoTitle');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl   = document.getElementById('totalTime');
const muteBtn          = document.getElementById('muteBtn');
const subtitleOverlay  = document.getElementById('subtitleOverlay');

/* ============================================================
   YouTube IFrame API
   ============================================================ */
window.onYouTubeIframeAPIReady = function () { ytApiReady = true; };

function createPlayer(vid) {
  if (player) { player.loadVideoById(vid); return; }
  player = new YT.Player('ytPlayer', {
    videoId: vid,
    playerVars: { autoplay: 0, modestbranding: 1, rel: 0, cc_load_policy: 0 },
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange },
  });
}

function onPlayerReady(e) {
  totalTimeEl.textContent = formatTime(e.target.getDuration());
  startSyncLoop();
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) startSyncLoop();
}

function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(syncTranscript, 100);
}

/* ============================================================
   Video — Transcript Sync
   ============================================================ */
function syncTranscript() {
  if (!player || typeof player.getCurrentTime !== 'function') return;
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
      if (next) { next.classList.add('active'); next.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    currentActiveIndex = newIdx;
  }

  // Overlay: strict time range — show only while start <= cur < end
  let overlayText = '';
  if (newIdx >= 0) {
    const seg = segments[newIdx];
    const start = seg.offset / 1000;
    const end   = start + seg.duration / 1000;
    if (cur >= start && cur < end) overlayText = seg.translatedText;
  }
  const current = subtitleOverlay.firstChild;
  if (overlayText) {
    if (!current || current.textContent !== overlayText)
      subtitleOverlay.innerHTML = `<span>${escHtml(overlayText)}</span>`;
  } else if (subtitleOverlay.innerHTML) {
    subtitleOverlay.innerHTML = '';
  }
}

/* ============================================================
   Load Video + Transcript
   ============================================================ */
async function load() {
  const url = urlInput.value.trim();
  if (!url) return;

  // Oldingi stream bo'lsa to'xtat
  if (currentEvtSource) { currentEvtSource.close(); currentEvtSource = null; }
  isLoading = false;

  const vid = extractVideoId(url);
  if (!vid) { showToast("⚠️ Noto'g'ri YouTube URL formati"); urlInput.focus(); return; }

  isLoading = true;
  videoId = vid;
  lastUrl = url;
  segments = [];
  currentActiveIndex = -1;

  setLoadingState(true);
  showWorkspace();
  resetTranscriptPanel();

  // Load YouTube player
  if (ytApiReady) createPlayer(vid);
  else {
    const wait = setInterval(() => { if (ytApiReady) { clearInterval(wait); createPlayer(vid); } }, 100);
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
    const r = await fetch(`/api/video-info?url=${encodeURIComponent(url)}`);
    const d = await r.json();
    if (d.title) { videoTitle.textContent = d.title; document.title = `${d.title} — O'zbek Transkript`; }
  } catch { videoTitle.textContent = 'YouTube Video'; }
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
      loadingStatus.textContent = `${msg.engine} bilan tarjima qilinmoqda...`;
    }

    if (msg.type === 'start') {
      total = msg.total;
      segmentCount.textContent = `0 / ${total}`;

      // Source badge
      const sourceLabel = msg.source === 'whisper'
        ? `🤖 Whisper AI transkriptsiya`
        : `📝 YouTube subtitrlar`;
      const langLabel = msg.lang && msg.lang !== 'uz' && msg.lang !== 'auto'
        ? msg.lang.toUpperCase()
        : '';
      sourceBadge.innerHTML = `<span>${sourceLabel}</span>${langLabel ? `<span class="lang-tag">${langLabel} → O'zbekcha</span>` : ''}`;
      sourceBadge.style.display = 'flex';

      if (msg.needsTranslation) {
        loadingStatus.textContent = `Tarjima qilinmoqda (${total} segment)...`;
      } else {
        loadingStatus.textContent = `O'zbek subtitrlar yuklanmoqda (${total} segment)...`;
      }
      addSkeletons(Math.min(total, 8));
    }

    if (msg.type === 'segment') {
      removeFirstSkeleton();
      const seg = { index: msg.index, offset: msg.offset, duration: msg.duration,
        originalText: msg.originalText, translatedText: msg.translatedText };
      segments[msg.index] = seg;
      loaded++;
      appendSegment(seg);
      segmentCount.textContent = `${loaded} / ${total}`;
    }

    if (msg.type === 'progress') {
      loadingFill.style.width = `${(msg.done / msg.total) * 100}%`;
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
      showToast('✅ Transkript tayyor!');
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

/* ============================================================
   DOM Helpers
   ============================================================ */
function appendSegment(seg) {
  const div = document.createElement('div');
  div.className = 'segment';
  div.dataset.index = seg.index;
  div.dataset.translated = (seg.translatedText || '').toLowerCase();
  div.dataset.original   = (seg.originalText || '').toLowerCase();

  div.innerHTML = `
    <div class="segment-time"><span class="time-tag">${formatTime(seg.offset / 1000)}</span></div>
    <div class="segment-text">${escHtml(seg.translatedText)}</div>
    <div class="segment-original">${escHtml(seg.originalText)}</div>
  `;

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
    div.innerHTML = `
      <div class="skeleton-line skeleton-time"></div>
      <div class="skeleton-line skeleton-text" style="width:${70 + Math.random() * 25}%"></div>
    `;
    segmentsEl.appendChild(div);
  }
}

function removeFirstSkeleton() {
  const sk = segmentsEl.querySelector('.skeleton');
  if (sk) sk.remove();
}

function resetTranscriptPanel() {
  segmentsEl.innerHTML = '';
  subtitleOverlay.innerHTML = '';
  errorState.style.display = 'none';
  sourceBadge.style.display = 'none';
  whisperBadge.style.display = 'none';
  loadingBar.style.display = 'block';
  loadingFill.style.width = '0%';
  loadingFill.style.background = 'linear-gradient(90deg, var(--red), var(--blue))';
  loadingStatus.textContent = 'Subtitrlar tekshirilmoqda...';
  segmentCount.textContent = '—';
  currentTimeEl.textContent = '0:00';
  totalTimeEl.textContent = '0:00';
}

function showWorkspace() {
  welcome.style.display = 'none';
  workspace.style.display = 'flex';
}

function setLoadingState(loading) {
  loadBtn.classList.toggle('loading', loading);
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
  searchQuery = query.toLowerCase().trim();
  let matchCount = 0;
  segmentsEl.querySelectorAll('.segment').forEach(el => {
    const idx = el.dataset.index;
    const seg = segments[idx];
    if (!seg) return;
    if (!searchQuery) {
      el.classList.remove('hidden');
      el.querySelector('.segment-text').innerHTML = escHtml(seg.translatedText);
      el.querySelector('.segment-original').innerHTML = escHtml(seg.originalText);
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
  return text.replace(new RegExp(`(${escRegex(query)})`, 'gi'), '<span class="highlight">$1</span>');
}

/* ============================================================
   Download / Copy
   ============================================================ */
function buildTranscriptText() {
  return segments.filter(Boolean)
    .map(s => `[${formatTime(s.offset / 1000)}] ${s.translatedText}`)
    .join('\n');
}

function downloadTranscript() {
  const text = buildTranscriptText();
  if (!text) { showToast("Hali transkript yo'q"); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transkript-${videoId || 'video'}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('📥 Transkript yuklab olindi');
}

function copyTranscript() {
  const text = buildTranscriptText();
  if (!text) { showToast("Hali transkript yo'q"); return; }
  navigator.clipboard.writeText(text)
    .then(() => showToast('📋 Transkript nusxalandi'))
    .catch(() => showToast('⚠️ Nusxalash amalga oshmadi'));
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
  if (!sec || isNaN(sec)) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
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

searchInput.addEventListener('input', () => applySearch(searchInput.value));
copyBtn.addEventListener('click', copyTranscript);
downloadBtn.addEventListener('click', downloadTranscript);

retryBtn.addEventListener('click', () => {
  if (lastUrl) { urlInput.value = lastUrl; load(); }
});

muteBtn.addEventListener('click', () => {
  if (!player) return;
  if (player.isMuted()) { player.unMute(); muteBtn.style.opacity = '1'; }
  else { player.mute(); muteBtn.style.opacity = '0.4'; }
});

document.addEventListener('keydown', e => {
  if (e.target === urlInput || e.target === searchInput) return;
  if (e.code === 'Space' && player) {
    e.preventDefault();
    player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
  }
});

/* ============================================================
   Auth & Landing
   ============================================================ */
let currentUser = null;

async function initAuth() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();

    if (!data.loggedIn) {
      document.getElementById('landingPage').style.display = 'block';
      document.getElementById('appContainer').style.display = 'none';
      document.getElementById('headerGuest').style.display = 'flex';
      return;
    }

    currentUser = data;
    document.getElementById('landingPage').style.display = 'none';
    document.getElementById('appContainer').style.display = 'block';
    document.getElementById('headerGuest').style.display = 'none';
    document.getElementById('headerUser').style.display = 'flex';

    const avatar = document.getElementById('userAvatar');
    if (data.picture) avatar.src = data.picture;

    document.getElementById('userDropdownName').textContent = data.name || '';
    document.getElementById('userDropdownEmail').textContent = data.email || '';
    document.getElementById('userDropdownTier').textContent = data.isPremium ? '⚡ Premium' : 'Bepul tarif';

    const upgradeBtn = document.getElementById('upgradeBtn');
    if (data.isPremium) {
      upgradeBtn.textContent = '⚡ Premium';
      upgradeBtn.classList.add('premium-active');
    }

    const tierBanner = document.getElementById('tierBanner');
    if (data.isPremium) {
      tierBanner.textContent = '⚡ Premium: Claude AI tarjima faol';
      tierBanner.style.borderColor = '#f59e0b';
      tierBanner.style.color = '#f59e0b';
    } else {
      tierBanner.textContent = 'Bepul tarif: Google Translate ishlatilmoqda';
    }

    urlInput.focus();
  } catch (e) {
    console.error('Auth xato:', e);
  }
}

document.getElementById('userAvatar').addEventListener('click', () => {
  const dd = document.getElementById('userDropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('click', e => {
  const menu = document.getElementById('userMenu');
  if (menu && !menu.contains(e.target))
    document.getElementById('userDropdown').style.display = 'none';
});

document.getElementById('upgradeBtn').addEventListener('click', () => {
  document.getElementById('upgradeModal').style.display = 'flex';
});

document.getElementById('modalClose').addEventListener('click', () => {
  document.getElementById('upgradeModal').style.display = 'none';
});

document.getElementById('upgradeModal').addEventListener('click', e => {
  if (e.target === document.getElementById('upgradeModal'))
    document.getElementById('upgradeModal').style.display = 'none';
});

initAuth();
