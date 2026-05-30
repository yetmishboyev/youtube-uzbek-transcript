require('dotenv').config();
const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;
const WHISPER_SCRIPT = path.join(__dirname, 'whisper_transcribe.py');
const YTDLP_BIN   = '/Library/Frameworks/Python.framework/Versions/3.10/bin/yt-dlp';
const PYTHON_BIN  = '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3';

// Anthropic client
const anthropic = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_api_key_here'
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// PostgreSQL pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ─── Session ──────────────────────────────────────────────────── */
app.use(express.json());
app.use(session({
  store: new pgSession({ pool, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

/* ─── Auth middleware ──────────────────────────────────────────── */
async function loadUser(req, res, next) {
  if (req.session.userId) {
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
      req.user = rows[0] || null;
    } catch { req.user = null; }
  }
  next();
}
app.use(loadUser);

/* ─── Auth routes ──────────────────────────────────────────────── */
app.post('/auth/email', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email))
    return res.status(400).json({ error: "To'g'ri email kiriting" });

  try {
    const name = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) || 'user';
    const { rows } = await pool.query(
      `INSERT INTO users (email, name)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
       RETURNING *`,
      [email, name]
    );
    req.session.userId = rows[0].id;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server xato' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Session destroy xato:', err.message);
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    name: req.user.name,
    email: req.user.email,
    isPremium: req.user.is_premium,
  });
});

app.post('/api/upgrade', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login kerak' });
  res.json({ status: 'coming_soon', message: "To'lov tizimi tez kunda qo'shiladi!" });
});

// last_seen yangilash
app.use((req, res, next) => {
  if (req.user) {
    pool.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [req.user.id]).catch(() => {});
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================
   ADMIN PANEL
   ================================================================ */

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Admin login kerak' });
}

// Admin login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Noto'g'ri parol" });
});

app.post('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

// Admin panel HTML
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Dashboard stats
app.get('/admin/api/stats', requireAdmin, async (req, res) => {
  try {
    const [total, premium, today, week, active7d] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_premium=true'),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '1 day'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) FROM users WHERE last_seen >= NOW() - INTERVAL '7 days'"),
    ]);
    res.json({
      total: parseInt(total.rows[0].count),
      premium: parseInt(premium.rows[0].count),
      free: parseInt(total.rows[0].count) - parseInt(premium.rows[0].count),
      newToday: parseInt(today.rows[0].count),
      newWeek: parseInt(week.rows[0].count),
      active7d: parseInt(active7d.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Users list
app.get('/admin/api/users', requireAdmin, async (req, res) => {
  try {
    const { search = '', filter = 'all', sort = 'newest', page = 1 } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;

    let where = [];
    let params = [];

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(name) LIKE $${params.length})`);
    }
    if (filter === 'premium') where.push('is_premium=true');
    if (filter === 'free') where.push('is_premium=false');

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderMap = { newest: 'created_at DESC', oldest: 'created_at ASC', active: 'last_seen DESC NULLS LAST', email: 'email ASC' };
    const orderClause = orderMap[sort] || 'created_at DESC';

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, email, name, is_premium, created_at, last_seen, total_videos
       FROM users ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, -2);
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM users ${whereClause}`, countParams
    );

    res.json({ users: rows, total: parseInt(countRows[0].count), page: parseInt(page), limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Premium toggle
app.patch('/admin/api/users/:id/premium', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_premium = NOT is_premium WHERE id=$1 RETURNING id, email, is_premium',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    await pool.query(
      'INSERT INTO admin_log (admin_action, target_user_id, target_email, details) VALUES ($1,$2,$3,$4)',
      ['toggle_premium', rows[0].id, rows[0].email, rows[0].is_premium ? 'premium berildi' : 'premium olib tashlandi']
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete user
app.delete('/admin/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM users WHERE id=$1 RETURNING email', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    await pool.query(
      'INSERT INTO admin_log (admin_action, target_email, details) VALUES ($1,$2,$3)',
      ['delete_user', rows[0].email, "foydalanuvchi o'chirildi"]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin log
app.get('/admin/api/log', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// System status
app.get('/admin/api/system', requireAdmin, async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      db: 'ok',
      claude: anthropic ? 'ok' : 'no_key',
      uptime: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  } catch (e) { res.json({ db: 'error', error: e.message }); }
});

/* ─── URL parsing ──────────────────────────────────────────────── */
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

/* ─── HTML entity decode ───────────────────────────────────────── */
function decodeEntities(text) {
  return (text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#10;/g, ' ').replace(/&#13;/g, '').replace(/&nbsp;/g, ' ')
    .replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── Claude Haiku tarjima (asosiy, sifatli) ──────────────────── */
async function translateWithClaude(texts, sourceLang = 'en') {
  if (!anthropic) return null; // API key yo'q

  const langNames = {
    en: 'inglizcha', ru: 'ruscha', tr: 'turkcha',
    ar: 'arabcha', de: 'nemischa', fr: 'fransuzcha',
    es: 'ispancha', auto: 'inglizcha',
  };
  const langName = langNames[sourceLang] || sourceLang;

  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const prompt = `Siz professional tarjimon siz. Quyidagi ${langName} gaplarni tabiiy, sodda va ravon o'zbek tiliga tarjima qiling.

Qoidalar:
- Tarjima jonli, inson tushinadigan o'zbek tilida bo'lsin
- Asl ma'noni to'liq saqlang
- So'zma-so'z tarjima QILMANG — ma'nosini o'zbek tiliga moslab yozing
- Qisqa, aniq va ravon bo'lsin
- Faqat tarjima matnini yozing, izoh yoki tushuntirish qo'shmang

Javob formatı — har bir qator raqam bilan:
1. [tarjima]
2. [tarjima]
...

${langName.charAt(0).toUpperCase() + langName.slice(1)} matni:
${numbered}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const output = resp.content[0]?.text || '';
    const lines = output.split('\n').filter(l => /^\d+\./.test(l.trim()));
    const results = lines.map(l => l.replace(/^\d+\.\s*/, '').trim());

    if (results.length === texts.length) return results;

    // Agar soni mos kelmasa, fallback qilamiz
    return null;
  } catch (err) {
    console.error('Claude xato:', err.message);
    return null;
  }
}

/* ─── Google Translate (fallback) ─────────────────────────────── */
async function translateGoogle(text, sourceLang = 'auto', retries = 2) {
  const q = text.substring(0, 4800);
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: sourceLang, tl: 'uz', dt: 't', q },
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (Array.isArray(resp.data?.[0])) {
        return resp.data[0].map(item => item?.[0] || '').join('').trim();
      }
    } catch {
      if (i < retries) await sleep(600 * (i + 1));
    }
  }
  return text;
}

/* ─── Batch tarjima funksiyalari ───────────────────────────────── */
const BATCH = 20;

// Premium: Claude Haiku
async function translateBatch(texts, sourceLang = 'auto') {
  const claudeResult = await translateWithClaude(texts, sourceLang);
  if (claudeResult) return claudeResult;
  return translateBatchGoogle(texts, sourceLang);
}

// Bepul: Google Translate
async function translateBatchGoogle(texts, sourceLang = 'auto') {
  const SEP = '\n||||\n';
  const joined = texts.join(SEP).substring(0, 4800);
  const translated = await translateGoogle(joined, sourceLang);
  const parts = translated.split(/\n?\|\|\|\|\n?/);

  if (parts.length === texts.length) return parts.map(p => p.trim());

  const results = [];
  for (const t of texts) {
    results.push(await translateGoogle(t, sourceLang));
    await sleep(120);
  }
  return results;
}

/* ─── YouTube captions ─────────────────────────────────────────── */
async function fetchYouTubeCaptions(videoId) {
  const langs = ['uz', 'en', 'ru', 'tr', 'ar'];
  for (const lang of langs) {
    try {
      const t = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (t?.length) return { transcript: t, lang };
    } catch {}
  }
  try {
    const t = await YoutubeTranscript.fetchTranscript(videoId);
    if (t?.length) return { transcript: t, lang: 'auto' };
  } catch {}
  return null;
}

/* ─── yt-dlp audio download ────────────────────────────────────── */
function downloadAudio(url, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-x', '--audio-format', 'mp3', '--audio-quality', '5',
      '--no-playlist', '--quiet',
      '-o', outPath + '.%(ext)s', url,
    ];
    const proc = spawn(YTDLP_BIN, args, { timeout: 180000 });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      code === 0 ? resolve() : reject(new Error(`yt-dlp: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

/* ─── Whisper transcription ────────────────────────────────────── */
function runWhisper(audioPath, model = 'small') {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [WHISPER_SCRIPT, audioPath, model], {
      timeout: 600000,
      maxBuffer: 50 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Whisper: ${stderr?.slice(-300) || err.message}`));
      try {
        const jsonLine = stdout.split('\n').find(l => l.trim().startsWith('{'));
        if (!jsonLine) return reject(new Error('Whisper JSON topilmadi'));
        const data = JSON.parse(jsonLine);
        if (data.error) return reject(new Error(data.error));
        resolve(data);
      } catch (e) {
        reject(new Error(`Whisper parse: ${e.message}`));
      }
    });
  });
}

function cleanupFiles(prefix) {
  fs.readdirSync(os.tmpdir())
    .filter(f => f.startsWith(prefix))
    .forEach(f => { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} });
}

/* ─── SSE helper ───────────────────────────────────────────────── */
function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = data => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
  const finish = () => { clearInterval(heartbeat); if (!res.writableEnded) res.end(); };
  return { send, finish };
}

/* ─── Segmentlarni tarjima qilib stream qilish ─────────────────── */
async function translateAndStream(transcript, lang, send, needsTranslation, isCancelled = () => false, usePremium = false) {
  const total = transcript.length;

  if (!needsTranslation) {
    for (let i = 0; i < total; i++) {
      if (isCancelled()) return;
      const t = decodeEntities(transcript[i].text);
      send({ type: 'segment', index: i, offset: transcript[i].offset, duration: transcript[i].duration,
        originalText: t, translatedText: t });
    }
    return;
  }

  const useAI = usePremium && anthropic;
  const engine = useAI ? 'Claude Haiku' : 'Google Translate';
  send({ type: 'engine', engine });

  for (let i = 0; i < total; i += BATCH) {
    if (isCancelled()) return;
    const batch = transcript.slice(i, Math.min(i + BATCH, total));
    const texts = batch.map(item => decodeEntities(item.text));

    const translated = useAI
      ? await translateBatch(texts, lang === 'auto' ? 'en' : lang)
      : await translateBatchGoogle(texts, lang === 'auto' ? 'en' : lang);

    if (isCancelled()) return;
    batch.forEach((item, j) => {
      send({
        type: 'segment', index: i + j,
        offset: item.offset, duration: item.duration,
        originalText: texts[j],
        translatedText: translated[j] || texts[j],
      });
    });

    send({ type: 'progress', done: Math.min(i + BATCH, total), total });
    if (i + BATCH < total) await sleep(useAI ? 200 : 280);
  }
}

/* ─── Asosiy SSE endpoint ──────────────────────────────────────── */
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL kerak' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Noto'g'ri YouTube URL" });

  const { send, finish } = setupSSE(res);

  let cancelled = false;
  req.on('close', () => { cancelled = true; });
  const isCancelled = () => cancelled;
  const usePremium = req.user?.is_premium === true;

  try {
    /* ── 1. YouTube subtitri ── */
    send({ type: 'status', message: 'YouTube subtitrlar tekshirilmoqda...' });
    const captionResult = await fetchYouTubeCaptions(videoId);

    if (isCancelled()) return finish();

    if (captionResult) {
      const { transcript, lang } = captionResult;
      const needsTranslation = lang !== 'uz';
      send({ type: 'start', total: transcript.length, needsTranslation, videoId,
        source: 'captions', lang });
      await translateAndStream(transcript, lang, send, needsTranslation, isCancelled, usePremium);
      if (!isCancelled()) send({ type: 'done' });
      return finish();
    }

    /* ── 2. Whisper pipeline ── */
    send({ type: 'status', message: "Subtitr topilmadi — Whisper AI boshlanmoqda..." });
    send({ type: 'whisper_mode' });

    const tmpPrefix = `yt-${videoId}`;
    const tmpBase   = path.join(os.tmpdir(), tmpPrefix);

    send({ type: 'status', message: '🎵 Audio yuklanmoqda (yt-dlp)...' });
    try {
      await downloadAudio(`https://www.youtube.com/watch?v=${videoId}`, tmpBase);
    } catch (e) {
      send({ type: 'error', message: `Audio yuklab bo'lmadi: ${e.message}` });
      return finish();
    }

    if (isCancelled()) return finish();

    const tmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(tmpPrefix));
    if (!tmpFiles.length) {
      send({ type: 'error', message: 'Audio fayl topilmadi' });
      return finish();
    }

    send({ type: 'status', message: '🤖 Whisper AI transkriptsiya qilmoqda...' });
    let whisperResult;
    try {
      whisperResult = await runWhisper(path.join(os.tmpdir(), tmpFiles[0]), 'small');
    } catch (e) {
      cleanupFiles(tmpPrefix);
      send({ type: 'error', message: `Whisper: ${e.message}` });
      return finish();
    }
    cleanupFiles(tmpPrefix);

    if (isCancelled()) return finish();

    const { segments: segs, language: detectedLang } = whisperResult;
    if (!segs?.length) {
      send({ type: 'error', message: "Audio transkriptsiya bo'sh natija" });
      return finish();
    }

    const needsTranslation = detectedLang !== 'uz';
    send({ type: 'start', total: segs.length, needsTranslation, videoId,
      source: 'whisper', lang: detectedLang });

    // Whisper segmentlarini transcript formatiga o'tkazish
    const asTranscript = segs.map(s => ({ text: s.text, offset: s.offset, duration: s.duration }));
    await translateAndStream(asTranscript, detectedLang, send, needsTranslation, isCancelled, usePremium);
    if (!isCancelled()) send({ type: 'done' });
    finish();

  } catch (err) {
    console.error(err);
    send({ type: 'error', message: `Xato: ${err.message}` });
    finish();
  }
});

/* ─── Video info ───────────────────────────────────────────────── */
app.get('/api/video-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL kerak' });
  try {
    const r = await axios.get('https://noembed.com/embed', { params: { url }, timeout: 8000 });
    res.json(r.data);
  } catch {
    res.status(500).json({ error: "Video ma'lumotlari olinmadi" });
  }
});

/* ─── Social post generator (Premium) ─────────────────────────── */
app.post('/api/generate-post', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login kerak' });
  if (!req.user.is_premium) return res.status(403).json({ error: 'Bu funksiya faqat Premium foydalanuvchilar uchun' });
  if (!anthropic) return res.status(503).json({ error: 'AI xizmati mavjud emas' });

  const { url, platform } = req.body;
  if (!url || !platform) return res.status(400).json({ error: 'URL va platform kerak' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Noto'g'ri YouTube URL" });

  const platformPrompts = {
    instagram: `Siz professional Instagram kontent yaratuvchisisiz. Quyidagi YouTube video uchun o'zbek tilida Instagram post yozing.
Talablar:
- Jozibali sarlavha va matn (2-3 qisqa paragraf)
- 15-20 ta tegishli hashtag (#uzbek #uz va hokazo)
- Emoji-lar qo'shing
- "Bio linkga o'ting" yoki "Post saqlang" kabi call-to-action
- Instagram auditoriyasiga mos: vizual, ilhomlantiruvchi, qisqa`,

    telegram: `Siz professional Telegram kanal adminsiz. Quyidagi YouTube video uchun o'zbek tilida Telegram post yozing.
Talablar:
- Qiziqarli sarlavha (bold qiling: **sarlavha**)
- Video haqida asosiy fikrlar (3-5 ta bullet point)
- O'quvchini davom ettirishga undovchi matn
- Telegram formatida: **bold**, __italic__, emoji-lar
- Havolaga yo'naltirish: "Video: [havola]"
- 300-500 so'z`,

    facebook: `Siz professional Facebook SMM mutaxassisisiz. Quyidagi YouTube video uchun o'zbek tilida Facebook post yozing.
Talablar:
- Do'stona va samimiy ohang
- Video haqida qiziqarli hikoya (3-4 paragraf)
- Izoh qoldirishga undovchi savol
- Emoji-lar
- "Ulashing" va "Like" ga undash
- 200-400 so'z`,

    linkedin: `Siz professional LinkedIn kontent strategisiz. Quyidagi YouTube video uchun o'zbek tilida LinkedIn post yozing.
Talablar:
- Professional va kasbiy ohang
- Video-dan 3-5 ta asosiy xulosa yoki ta'lim
- Kasbiy rivojlanishga aloqador tushunchalar
- Minimal emoji (faqat zarur hollarda)
- Savol yoki fikr almashishga undash
- 300-500 so'z`,

    twitter: `Siz professional Twitter/X kontent mutaxassisisiz. Quyidagi YouTube video uchun o'zbek tilida Twitter/X thread yozing.
Talablar:
- 5-7 ta tweet-dan iborat thread
- Har bir tweet 280 belgidan oshmasin
- Birinchi tweet juda e'tiborli bo'lsin
- Raqamlar bilan: 1/, 2/, 3/ ...
- Tegishli hashtag-lar (2-3 ta)
- Emoji-lar`,

    youtube: `Siz professional YouTube kontent yaratuvchisisiz. Quyidagi YouTube video uchun o'zbek tilida YouTube Community post yozing.
Talablar:
- Yangi video e'lon qilish formatida
- Videoning asosiy mavzusi va foydalari
- Tomosha qilishga undash
- Savollar va muhokama uchun izoh qoldiring
- Emoji-lar
- 150-300 so'z`,
  };

  const platformNames = {
    instagram: 'Instagram', telegram: 'Telegram', facebook: 'Facebook',
    linkedin: 'LinkedIn', twitter: 'Twitter/X', youtube: 'YouTube Community',
  };

  if (!platformPrompts[platform]) return res.status(400).json({ error: "Noto'g'ri platform" });

  try {
    // Video sarlavhasini ol
    let videoTitle = '';
    try {
      const infoRes = await axios.get('https://noembed.com/embed',
        { params: { url: `https://www.youtube.com/watch?v=${videoId}` }, timeout: 6000 });
      videoTitle = infoRes.data?.title || '';
    } catch {}

    // Transkriptni ol
    let transcriptText = '';
    try {
      const captions = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'uz' })
        .catch(() => YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' }))
        .catch(() => YoutubeTranscript.fetchTranscript(videoId));
      if (captions?.length) {
        transcriptText = captions.map(c => decodeEntities(c.text)).join(' ').slice(0, 4000);
      }
    } catch {}

    const videoInfo = [
      videoTitle ? `Video sarlavhasi: "${videoTitle}"` : '',
      `Video URL: https://www.youtube.com/watch?v=${videoId}`,
      transcriptText ? `\nVideo mazmuni (transkript):\n${transcriptText}` : '\n[Transkript mavjud emas — sarlavha asosida yozing]',
    ].filter(Boolean).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `${platformPrompts[platform]}\n\n${videoInfo}\n\nFaqat post matnini yozing, boshqa izoh qo'shmang.`,
      }],
    });

    res.json({ post: message.content[0].text, platform: platformNames[platform] });
  } catch (err) {
    console.error('generate-post error:', err);
    res.status(500).json({ error: 'Post yaratishda xato: ' + err.message });
  }
});

/* ─── API holati ───────────────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({
    translation: anthropic ? 'claude-haiku' : 'google-translate',
    whisper: 'small',
  });
});

app.listen(PORT, async () => {
  const engine = anthropic ? '✨ Claude Haiku' : '🌐 Google Translate (fallback)';
  console.log(`\n🎬 YouTube O'zbek Transkript`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🤖 Whisper: small model`);
  console.log(`${engine}: tarjima`);
  try {
    await pool.query('SELECT 1');
    console.log(`🗄️  PostgreSQL: ulandi\n`);
  } catch (e) {
    console.error(`❌ PostgreSQL ulanmadi: ${e.message}\n`);
  }
});
