require('dotenv').config();
const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const WHISPER_SCRIPT = path.join(__dirname, 'whisper_transcribe.py');
const YTDLP_BIN   = '/Library/Frameworks/Python.framework/Versions/3.10/bin/yt-dlp';
const PYTHON_BIN  = '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3';

// Anthropic client — faqat API key bo'lsa ishlatiladi
const anthropic = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_api_key_here'
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
        timeout: 12000,
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

/* ─── Asosiy batch tarjima (Claude → Google fallback) ─────────── */
const BATCH = 20;

async function translateBatch(texts, sourceLang = 'auto') {
  // 1. Claude bilan sinab ko'r
  const claudeResult = await translateWithClaude(texts, sourceLang);
  if (claudeResult) return claudeResult;

  // 2. Google Translate fallback (bitta matn sifatida)
  const SEP = '\n||||\n';
  const joined = texts.join(SEP).substring(0, 4800);
  const translated = await translateGoogle(joined, sourceLang);
  const parts = translated.split(/\n?\|\|\|\|\n?/);

  if (parts.length === texts.length) return parts.map(p => p.trim());

  // 3. Har biri alohida tarjima
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
async function translateAndStream(transcript, lang, send, needsTranslation) {
  const total = transcript.length;

  if (!needsTranslation) {
    transcript.forEach((item, i) => {
      const t = decodeEntities(item.text);
      send({ type: 'segment', index: i, offset: item.offset, duration: item.duration,
        originalText: t, translatedText: t });
    });
    return;
  }

  const engine = anthropic ? 'Claude Haiku' : 'Google Translate';
  send({ type: 'engine', engine });

  for (let i = 0; i < total; i += BATCH) {
    const batch = transcript.slice(i, Math.min(i + BATCH, total));
    const texts = batch.map(item => decodeEntities(item.text));

    const translated = await translateBatch(texts, lang === 'auto' ? 'en' : lang);

    batch.forEach((item, j) => {
      send({
        type: 'segment', index: i + j,
        offset: item.offset, duration: item.duration,
        originalText: texts[j],
        translatedText: translated[j] || texts[j],
      });
    });

    send({ type: 'progress', done: Math.min(i + BATCH, total), total });
    if (i + BATCH < total) await sleep(anthropic ? 200 : 280);
  }
}

/* ─── Asosiy SSE endpoint ──────────────────────────────────────── */
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL kerak' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Noto'g'ri YouTube URL" });

  const { send, finish } = setupSSE(res);

  try {
    /* ── 1. YouTube subtitri ── */
    send({ type: 'status', message: 'YouTube subtitrlar tekshirilmoqda...' });
    const captionResult = await fetchYouTubeCaptions(videoId);

    if (captionResult) {
      const { transcript, lang } = captionResult;
      const needsTranslation = lang !== 'uz';
      send({ type: 'start', total: transcript.length, needsTranslation, videoId,
        source: 'captions', lang });
      await translateAndStream(transcript, lang, send, needsTranslation);
      send({ type: 'done' });
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
    await translateAndStream(asTranscript, detectedLang, send, needsTranslation);
    send({ type: 'done' });
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

/* ─── API holati ───────────────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({
    translation: anthropic ? 'claude-haiku' : 'google-translate',
    whisper: 'small',
  });
});

app.listen(PORT, () => {
  const engine = anthropic ? '✨ Claude Haiku' : '🌐 Google Translate (fallback)';
  console.log(`\n🎬 YouTube O'zbek Transkript`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🤖 Whisper: small model`);
  console.log(`${engine}: tarjima\n`);
});
