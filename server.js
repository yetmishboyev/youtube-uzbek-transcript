const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const axios = require('axios');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;
const WHISPER_SCRIPT = path.join(__dirname, 'whisper_transcribe.py');
const YTDLP_BIN = '/Library/Frameworks/Python.framework/Versions/3.10/bin/yt-dlp';
const PYTHON_BIN = '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ─── URL parsing ──────────────────────────────────────────── */
function extractVideoId(url) {
  url = (url || '').trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\n?#\s]+)/,
    /(?:youtu\.be\/)([^&\n?#\s]+)/,
    /(?:youtube\.com\/embed\/)([^&\n?#\s]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/* ─── HTML entity decode ───────────────────────────────────── */
function decodeEntities(text) {
  return (text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#10;/g, ' ').replace(/&#13;/g, '').replace(/&nbsp;/g, ' ')
    .replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/* ─── Google Translate (unofficial, free) ──────────────────── */
async function translateGoogle(text, targetLang = 'uz', sourceLang = 'auto', retries = 2) {
  const q = text.substring(0, 4800);
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: sourceLang, tl: targetLang, dt: 't', q },
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (Array.isArray(resp.data?.[0])) {
        return resp.data[0].map(item => item?.[0] || '').join('').trim();
      }
    } catch (e) {
      if (i < retries) await sleep(600 * (i + 1));
    }
  }
  return text;
}

/* ─── Batch translation (10 segments per request) ─────────── */
const SEP = '\n⟨⟩\n';

async function translateBatch(items, sourceLang = 'auto') {
  const joined = items.join(SEP).substring(0, 4800);
  const translated = await translateGoogle(joined, 'uz', sourceLang);
  const parts = translated.split(/\n?⟨⟩\n?/);
  // If split count mismatches, translate individually
  if (parts.length !== items.length) {
    const results = [];
    for (const item of items) {
      results.push(await translateGoogle(item, 'uz', sourceLang));
      await sleep(150);
    }
    return results;
  }
  return parts.map(p => p.trim());
}

/* ─── YouTube captions fetch ───────────────────────────────── */
async function fetchYouTubeCaptions(videoId) {
  const langs = ['uz', 'en', 'ru', 'tr', 'ar'];
  for (const lang of langs) {
    try {
      const t = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (t?.length) return { transcript: t, lang };
    } catch {}
  }
  // Try without specifying language (auto-generated)
  try {
    const t = await YoutubeTranscript.fetchTranscript(videoId);
    if (t?.length) return { transcript: t, lang: 'auto' };
  } catch {}
  return null;
}

/* ─── yt-dlp audio download ────────────────────────────────── */
function downloadAudio(url, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-x', '--audio-format', 'mp3', '--audio-quality', '5',
      '--no-playlist', '--quiet',
      '-o', outPath + '.%(ext)s',
      url,
    ];
    const proc = spawn(YTDLP_BIN, args, { timeout: 180000 });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp xato: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

/* ─── Whisper transcription ────────────────────────────────── */
function runWhisper(audioPath, model = 'small') {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [WHISPER_SCRIPT, audioPath, model], {
      timeout: 600000,
      maxBuffer: 50 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Whisper xato: ${stderr?.slice(-300) || err.message}`));
      try {
        // Find JSON line (whisper may print extra text to stdout)
        const jsonLine = stdout.split('\n').find(l => l.trim().startsWith('{'));
        if (!jsonLine) return reject(new Error('Whisper JSON natijasi topilmadi'));
        const data = JSON.parse(jsonLine);
        if (data.error) return reject(new Error(data.error));
        resolve(data);
      } catch (parseErr) {
        reject(new Error(`Whisper parse xato: ${parseErr.message}`));
      }
    });
  });
}

/* ─── Cleanup temp files ───────────────────────────────────── */
function cleanupFiles(prefix) {
  const dir = os.tmpdir();
  fs.readdirSync(dir).filter(f => f.startsWith(prefix)).forEach(f => {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── Main SSE endpoint ────────────────────────────────────── */
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'URL kerak' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Noto'g'ri YouTube URL" });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Keep connection alive during long Whisper operations
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20000);

  const finish = () => { clearInterval(heartbeat); if (!res.writableEnded) res.end(); };

  try {
    /* ── Step 1: Try YouTube captions ── */
    send({ type: 'status', message: 'YouTube subtitrlar tekshirilmoqda...' });
    const captionResult = await fetchYouTubeCaptions(videoId);

    if (captionResult) {
      const { transcript, lang } = captionResult;
      const needsTranslation = lang !== 'uz';

      send({ type: 'start', total: transcript.length, needsTranslation, videoId, source: 'captions', lang });

      if (!needsTranslation) {
        // Already Uzbek
        transcript.forEach((item, index) => {
          send({
            type: 'segment', index,
            offset: item.offset, duration: item.duration,
            originalText: decodeEntities(item.text),
            translatedText: decodeEntities(item.text),
          });
        });
        send({ type: 'done' });
        return finish();
      }

      // Translate in batches of 10
      const BATCH = 10;
      for (let i = 0; i < transcript.length; i += BATCH) {
        const batch = transcript.slice(i, Math.min(i + BATCH, transcript.length));
        const texts = batch.map(item => decodeEntities(item.text));
        const translated = await translateBatch(texts, lang === 'auto' ? 'auto' : lang);

        batch.forEach((item, j) => {
          send({
            type: 'segment', index: i + j,
            offset: item.offset, duration: item.duration,
            originalText: texts[j],
            translatedText: translated[j] || texts[j],
          });
        });

        send({ type: 'progress', done: Math.min(i + BATCH, transcript.length), total: transcript.length });
        if (i + BATCH < transcript.length) await sleep(250);
      }

      send({ type: 'done' });
      return finish();
    }

    /* ── Step 2: No captions → Whisper ── */
    send({ type: 'status', message: "Subtitr topilmadi — audio orqali transkriptsiya boshlanmoqda..." });
    send({ type: 'whisper_mode', message: "Whisper AI ishlatilmoqda" });

    const tmpPrefix = `yt-${videoId}`;
    const tmpBase = path.join(os.tmpdir(), tmpPrefix);

    // Download audio
    send({ type: 'status', message: '🎵 Audio yuklanmoqda (yt-dlp)...' });
    try {
      await downloadAudio(`https://www.youtube.com/watch?v=${videoId}`, tmpBase);
    } catch (dlErr) {
      send({ type: 'error', message: `Audio yuklab bo'lmadi: ${dlErr.message}` });
      return finish();
    }

    // Find the downloaded file
    const tmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(tmpPrefix));
    if (!tmpFiles.length) {
      send({ type: 'error', message: 'Audio fayl topilmadi' });
      return finish();
    }
    const audioPath = path.join(os.tmpdir(), tmpFiles[0]);

    // Whisper transcription
    send({ type: 'status', message: '🤖 Whisper AI transkriptsiya qilmoqda (biroz vaqt ketishi mumkin)...' });

    let whisperResult;
    try {
      whisperResult = await runWhisper(audioPath, 'small');
    } catch (wErr) {
      cleanupFiles(tmpPrefix);
      send({ type: 'error', message: `Whisper xato: ${wErr.message}` });
      return finish();
    }
    cleanupFiles(tmpPrefix);

    const { segments: whisperSegs, language: detectedLang } = whisperResult;

    if (!whisperSegs?.length) {
      send({ type: 'error', message: "Audio transkriptsiya bo'sh natija qaytardi" });
      return finish();
    }

    const needsTranslation = detectedLang !== 'uz';
    send({
      type: 'start', total: whisperSegs.length, needsTranslation, videoId,
      source: 'whisper', lang: detectedLang,
      message: `Whisper: ${detectedLang} tili aniqlandi`,
    });

    if (!needsTranslation) {
      whisperSegs.forEach((seg, index) => {
        send({ type: 'segment', index, offset: seg.offset, duration: seg.duration,
          originalText: seg.text, translatedText: seg.text });
      });
      send({ type: 'done' });
      return finish();
    }

    // Translate whisper output
    const BATCH = 10;
    for (let i = 0; i < whisperSegs.length; i += BATCH) {
      const batch = whisperSegs.slice(i, Math.min(i + BATCH, whisperSegs.length));
      const texts = batch.map(s => s.text);
      const translated = await translateBatch(texts, detectedLang || 'auto');

      batch.forEach((seg, j) => {
        send({
          type: 'segment', index: i + j,
          offset: seg.offset, duration: seg.duration,
          originalText: seg.text,
          translatedText: translated[j] || seg.text,
        });
      });

      send({ type: 'progress', done: Math.min(i + BATCH, whisperSegs.length), total: whisperSegs.length });
      if (i + BATCH < whisperSegs.length) await sleep(250);
    }

    send({ type: 'done' });
    finish();

  } catch (err) {
    console.error(err);
    send({ type: 'error', message: `Kutilmagan xato: ${err.message}` });
    finish();
  }
});

/* ─── Video info endpoint ──────────────────────────────────── */
app.get('/api/video-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL kerak' });
  try {
    const resp = await axios.get('https://noembed.com/embed', {
      params: { url }, timeout: 8000,
    });
    res.json(resp.data);
  } catch {
    res.status(500).json({ error: "Video ma'lumotlarini olishda xato" });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎬 YouTube O'zbek Transkript`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🤖 Whisper: small model`);
  console.log(`🌐 Tarjima: Google Translate\n`);
});
