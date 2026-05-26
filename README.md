# 🇺🇿 YouTube O'zbek Transkript

YouTube videolarini **real vaqtda o'zbek tiliga** tarjima qilib transkriptini ko'rsatuvchi veb-ilova.

- **Chap panel** — YouTube video player
- **O'ng panel** — O'zbek tilidagi transkript (video bilan sinxronlashgan)

---

## Imkoniyatlar

- 🔄 **Real vaqt tarjima** — segmentlar birin-ketin SSE orqali keladi
- 🤖 **Whisper AI** — subtitr o'chirilgan yoki subtitrsiz videolarni ham transkriptsiya qiladi
- 🌐 **Google Translate** — sifatli inglizcha → o'zbekcha tarjima
- ⏱️ **Video sinxronizatsiya** — joriy segment video bilan birga avtomatik ajratib ko'rsatiladi
- 🔍 **Qidiruv** — transkript ichida so'z qidirish
- 👁️ **Asl matn** — original va tarjima matnni birga ko'rish
- 📥 **Yuklab olish** — transkriptni `.txt` formatida saqlash
- 📋 **Nusxalash** — transkriptni clipboard ga nusxalash

---

## Ish tartibi

```
YouTube URL kiritiladi
       │
       ▼
YouTube subtitri bormi?
  ├── Ha  → Google Translate (en/ru/tr → uz)
  └── Yo'q → yt-dlp bilan audio yuklab oladi
                     │
                     ▼
              Whisper AI transkriptsiya
                     │
                     ▼
              Google Translate (→ uz)
```

---

## O'rnatish

### Talablar

| Talab | Versiya |
|-------|---------|
| Node.js | ≥ 18 |
| Python | ≥ 3.9 |
| ffmpeg | istalgan |

### 1. Reponi klonlash

```bash
git clone https://github.com/yetmishboyev/youtube-uzbek-transcript.git
cd youtube-uzbek-transcript
```

### 2. Node.js paketlarini o'rnatish

```bash
npm install
```

### 3. Python paketlarini o'rnatish

```bash
pip3 install yt-dlp openai-whisper
```

> **macOS foydalanuvchilari** — Python SSL sertifikatlarini yangilang:
> ```bash
> /Applications/Python\ 3.x/Install\ Certificates.command
> ```

### 4. Serverni ishga tushirish

```bash
npm start
```

Brauzerda oching: **http://localhost:3000**

---

## Ishlatish

1. YouTube video havolasini yoki ID sini kiriting
2. **Yuklash** tugmasini bosing (yoki `Enter`)
3. Chap tomonda video, o'ng tomonda o'zbek transkripti paydo bo'ladi
4. Segment ustiga bosing — video o'sha joyga o'tadi

---

## Texnologiyalar

| Qatlam | Texnologiya |
|--------|-------------|
| Backend | Node.js, Express |
| Transkriptsiya (subtitr bor) | `youtube-transcript` npm |
| Transkriptsiya (subtitrsiz) | `yt-dlp` + OpenAI Whisper (`small` model) |
| Tarjima | Google Translate (unofficial API) |
| Streaming | Server-Sent Events (SSE) |
| Frontend | Vanilla JS, YouTube IFrame API |

---

## Loyiha tuzilmasi

```
youtube-uzbek-transcript/
├── server.js                  # Express server, SSE, Whisper pipeline
├── whisper_transcribe.py      # Whisper AI wrapper (Python)
├── package.json
└── public/
    ├── index.html             # Asosiy sahifa (split layout)
    ├── style.css              # Dark theme
    └── app.js                 # YouTube IFrame API, sinxronizatsiya
```

---

## Litsenziya

MIT
