require('dotenv').config();
const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
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

// Resend (primary) yoki Gmail SMTP (local fallback)
const resendClient = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const mailer = !resendClient && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      family: 4,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;

async function sendOtpEmail(toEmail, code) {
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#0f0f0f;color:#fff;border-radius:12px">
      <h2 style="margin:0 0 8px;font-size:22px">Grgitton</h2>
      <p style="color:#aaa;margin:0 0 28px;font-size:14px">YouTube O'zbek Transkript</p>
      <p style="margin:0 0 12px;font-size:15px">Kirish uchun kod:</p>
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:20px;text-align:center;letter-spacing:12px;font-size:36px;font-weight:800;color:#ff0000">
        ${code}
      </div>
      <p style="color:#666;font-size:12px;margin:20px 0 0">Kod 10 daqiqa ichida amal qiladi. Agar siz yubormagansiz — e'tibor bermang.</p>
    </div>
  `;

  if (resendClient) {
    try {
      const { error } = await resendClient.emails.send({
        from: 'Grgitton <noreply@mail.promptai.uz>',
        to: toEmail,
        subject: `${code} — Grgitton kirish kodi`,
        html,
      });
      if (error) { console.error('Resend xato:', error.message); return false; }
      return true;
    } catch (err) {
      console.error('Resend xato:', err.message);
      return false;
    }
  }

  if (mailer) {
    try {
      await mailer.sendMail({
        from: `"Grgitton" <${process.env.GMAIL_USER}>`,
        to: toEmail,
        subject: `${code} — Grgitton kirish kodi`,
        html,
      });
      return true;
    } catch (err) {
      console.error('Email yuborishda xato:', err.message);
      return false;
    }
  }

  return false;
}

// PostgreSQL pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ─── Session ──────────────────────────────────────────────────── */
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'fallback-secret') {
  console.warn('⚠️  SESSION_SECRET .env da o\'rnatilmagan — ishlab chiqarish uchun majburiy!');
}
app.use(express.json());
app.use(session({
  store: new pgSession({ pool, tableName: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'grgitton-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' },
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

// Step 1: Email jo'natish — OTP bor bo'lsa email ga, yo'q bo'lsa to'g'ri login
app.post('/auth/send-otp', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email))
    return res.status(400).json({ error: "To'g'ri email kiriting" });

  if (!resendClient && !mailer) {
    // OTP tizimi sozlanmagan — to'g'ridan-to'g'ri login
    try {
      const name = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) || 'user';
      const { rows } = await pool.query(
        `INSERT INTO users (email, name) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
        [email, name]
      );
      req.session.userId = rows[0].id;
      return res.json({ ok: true, skipOtp: true });
    } catch { return res.status(500).json({ error: 'Server xato' }); }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  try {
    await pool.query(
      `INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)`,
      [email, code, expires]
    );
    const sent = await sendOtpEmail(email, code);
    if (!sent) return res.status(500).json({ error: "Email yuborishda xato. Gmail sozlamalarini tekshiring." });
    res.json({ ok: true, skipOtp: false });
  } catch { res.status(500).json({ error: 'Server xato' }); }
});

// Step 2: OTP tekshirish
app.post('/auth/verify-otp', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const code  = (req.body.code  || '').trim();
  if (!email || !code) return res.status(400).json({ error: "Email va kod kerak" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM otp_codes WHERE email=$1 AND code=$2 AND used=FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email, code]
    );
    if (!rows.length) return res.status(400).json({ error: "Kod noto'g'ri yoki muddati o'tgan" });

    await pool.query(`UPDATE otp_codes SET used=TRUE WHERE id=$1`, [rows[0].id]);
    const name = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) || 'user';
    const { rows: userRows } = await pool.query(
      `INSERT INTO users (email, name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
      [email, name]
    );
    req.session.userId = userRows[0].id;
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server xato' }); }
});

// Eski endpoint — orqaga mos
app.post('/auth/email', async (req, res) => {
  req.url = '/auth/send-otp';
  app._router.handle(req, res);
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

app.post('/api/request-upgrade', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login kerak' });
  if (req.user.is_premium) return res.json({ ok: true, already: true });
  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM upgrade_requests WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 day'`,
      [req.user.id]
    );
    if (!existing.length) {
      await pool.query(
        `INSERT INTO upgrade_requests (user_id, email) VALUES ($1, $2)`,
        [req.user.id, req.user.email]
      );
      await pool.query(
        `INSERT INTO admin_log (admin_action, target_user_id, target_email, details) VALUES ($1,$2,$3,$4)`,
        ['upgrade_request', req.user.id, req.user.email, `Premium so'rov: ${req.user.email}`]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server xato' }); }
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
    const [total, premium, today, week, active7d, pending] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_premium=true'),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '1 day'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) FROM users WHERE last_seen >= NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) FROM upgrade_requests WHERE status='pending'").catch(() => ({ rows: [{ count: 0 }] })),
    ]);
    res.json({
      total: parseInt(total.rows[0].count),
      premium: parseInt(premium.rows[0].count),
      free: parseInt(total.rows[0].count) - parseInt(premium.rows[0].count),
      newToday: parseInt(today.rows[0].count),
      newWeek: parseInt(week.rows[0].count),
      active7d: parseInt(active7d.rows[0].count),
      pendingUpgrades: parseInt(pending.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upgrade requests
app.get('/admin/api/upgrade-requests', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ur.id, ur.email, ur.created_at, ur.status, u.name, u.id as user_id, u.is_premium
       FROM upgrade_requests ur
       LEFT JOIN users u ON ur.user_id = u.id
       ORDER BY ur.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark upgrade request done
app.patch('/admin/api/upgrade-requests/:id/done', requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE upgrade_requests SET status='done' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
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

/* ─── Rate Limiting ────────────────────────────────────────────── */
const LIMITS = {
  transcript: { anonymous: { daily: 5, perMin: 2 }, free: { daily: 15, perMin: 3 }, premium: { daily: 50, perMin: 10 } },
  post:       { premium:   { daily: 20 } },
};

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

async function checkRateLimit(req, endpoint) {
  const userId = req.user?.id || null;
  const ip     = getClientIp(req);
  const tier   = !userId ? 'anonymous' : (req.user?.is_premium ? 'premium' : 'free');
  const limits = LIMITS[endpoint]?.[tier];
  if (!limits) return { allowed: false, reason: 'Bu amal sizning tarifingizda mavjud emas' };

  const col    = userId ? 'user_id' : 'ip_address';
  const val    = userId || ip;

  const [dayRow, minRow] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS cnt FROM api_logs WHERE ${col}=$1 AND endpoint=$2 AND created_at > NOW() - INTERVAL '1 day'`,  [val, endpoint]),
    limits.perMin
      ? pool.query(`SELECT COUNT(*) AS cnt FROM api_logs WHERE ${col}=$1 AND endpoint=$2 AND created_at > NOW() - INTERVAL '1 minute'`, [val, endpoint])
      : Promise.resolve({ rows: [{ cnt: 0 }] }),
  ]);

  const dailyUsed  = parseInt(dayRow.rows[0].cnt);
  const minUsed    = parseInt(minRow.rows[0].cnt);

  if (limits.perMin && minUsed >= limits.perMin) {
    return { allowed: false, reason: `Bir daqiqada ${limits.perMin} ta so'rov mumkin. Biroz kuting.`, dailyUsed, dailyLimit: limits.daily };
  }
  if (dailyUsed >= limits.daily) {
    const tierName = tier === 'anonymous' ? 'Tizimga kiring' : (tier === 'free' ? 'Premium oling' : '');
    return { allowed: false, reason: `Kunlik limit: ${limits.daily} ta. Ertaga qayta urinib ko'ring.${tierName ? ' ' + tierName + ' — ko\'proq limit.' : ''}`, dailyUsed, dailyLimit: limits.daily };
  }

  await pool.query('INSERT INTO api_logs (user_id, ip_address, endpoint) VALUES ($1,$2,$3)', [userId, ip, endpoint]);
  return { allowed: true, dailyUsed: dailyUsed + 1, dailyLimit: limits.daily };
}

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
  const engine = useAI ? 'Grgitton' : 'Grgitton';
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

  const rl = await checkRateLimit(req, 'transcript');
  if (!rl.allowed) {
    const { send: sendErr, finish: finishErr } = setupSSE(res);
    sendErr({ type: 'rate_limit', message: rl.reason, dailyUsed: rl.dailyUsed, dailyLimit: rl.dailyLimit });
    return finishErr();
  }

  const { send, finish } = setupSSE(res);
  send({ type: 'usage', dailyUsed: rl.dailyUsed, dailyLimit: rl.dailyLimit });

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
    send({ type: 'status', message: "Subtitr topilmadi — Grgitton AI boshlanmoqda..." });
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

    send({ type: 'status', message: '🤖 Grgitton transkriptsiya qilmoqda...' });
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

  const rl = await checkRateLimit(req, 'post');
  if (!rl.allowed) return res.status(429).json({ error: rl.reason, dailyUsed: rl.dailyUsed, dailyLimit: rl.dailyLimit });

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

/* ─── Foydalanuvchi kunlik sarfi ──────────────────────────────── */
app.get('/api/usage', async (req, res) => {
  const userId = req.user?.id || null;
  const ip     = getClientIp(req);
  const tier   = !userId ? 'anonymous' : (req.user?.is_premium ? 'premium' : 'free');
  const col    = userId ? 'user_id' : 'ip_address';
  const val    = userId || ip;

  try {
    const [tRow, pRow] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM api_logs WHERE ${col}=$1 AND endpoint='transcript' AND created_at > NOW() - INTERVAL '1 day'`, [val]),
      pool.query(`SELECT COUNT(*) AS cnt FROM api_logs WHERE ${col}=$1 AND endpoint='post'       AND created_at > NOW() - INTERVAL '1 day'`, [val]),
    ]);
    const tLimits = LIMITS.transcript[tier] || LIMITS.transcript.anonymous;
    const pLimits = LIMITS.post[tier] || null;

    res.json({
      tier,
      transcript: { used: parseInt(tRow.rows[0].cnt), limit: tLimits.daily },
      post: pLimits ? { used: parseInt(pRow.rows[0].cnt), limit: pLimits.daily } : null,
    });
  } catch {
    res.json({ tier, transcript: { used: 0, limit: LIMITS.transcript[tier]?.daily || 2 }, post: null });
  }
});

/* ─── Public statistika (landing social proof) ─────────────────── */
app.get('/api/public-stats', async (req, res) => {
  try {
    const [vids, users] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM api_logs WHERE endpoint='transcript'`),
      pool.query(`SELECT COUNT(*) FROM users`),
    ]);
    res.json({
      videosTranslated: parseInt(vids.rows[0].count),
      totalUsers: parseInt(users.rows[0].count),
    });
  } catch { res.json({ videosTranslated: 0, totalUsers: 0 }); }
});

/* ─── Transcript tarixi ─────────────────────────────────────────── */
app.post('/api/transcripts', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login kerak' });
  const { videoId, videoUrl, title, segmentCount } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId kerak' });
  try {
    await pool.query(
      `INSERT INTO transcripts (user_id, video_id, video_url, title, segment_count)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, video_id)
       DO UPDATE SET title=EXCLUDED.title, segment_count=EXCLUDED.segment_count, created_at=NOW()`,
      [req.user.id, videoId, videoUrl || '', title || '', segmentCount || 0]
    );
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server xato' }); }
});

app.get('/api/transcripts', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login kerak' });
  try {
    const { rows } = await pool.query(
      `SELECT id, video_id, video_url, title, segment_count, created_at
       FROM transcripts WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(rows);
  } catch { res.status(500).json({ error: 'Server xato' }); }
});

/* ─── API holati ───────────────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({
    translation: anthropic ? 'grgitton-ai' : 'grgitton-basic',
    whisper: 'small',
  });
});

app.listen(PORT, async () => {
  const engine = anthropic ? '✨ Grgitton AI (premium)' : '🌐 Grgitton Basic';
  console.log(`\n🎬 YouTube O'zbek Transkript — Grgitton`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🤖 Audio: Grgitton AI`);
  console.log(`${engine}: tarjima`);
  try {
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        email      VARCHAR(255) UNIQUE NOT NULL,
        name       VARCHAR(255),
        is_premium BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen  TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid    VARCHAR NOT NULL COLLATE "default",
        sess   JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL,
        CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_logs (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ip_address VARCHAR(45),
        endpoint   VARCHAR(30) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_logs_user   ON api_logs(user_id, endpoint, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_logs_ip     ON api_logs(ip_address, endpoint, created_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS upgrade_requests (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email      VARCHAR(255),
        status     VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id         SERIAL PRIMARY KEY,
        email      VARCHAR(255) NOT NULL,
        code       VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
        video_id       VARCHAR(20) NOT NULL,
        video_url      TEXT DEFAULT '',
        title          VARCHAR(500) DEFAULT '',
        segment_count  INTEGER DEFAULT 0,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, video_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transcripts_user ON transcripts(user_id, created_at DESC)`);
    await pool.query(`-- otp cleanup: eski kodlarni o'chirish (startup da bir marta) -- SELECT 1`);
    pool.query(`DELETE FROM otp_codes WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    console.log(`🗄️  PostgreSQL: ulandi\n`);
  } catch (e) {
    console.error(`❌ PostgreSQL ulanmadi: ${e.message}\n`);
  }
});
