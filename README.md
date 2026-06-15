# AudioShift Server

Backend Node.js + FFmpeg untuk konversi audio AudioShift.

## Fitur

- **Kecepatan** (0.5x – 4x): menggunakan filter `atempo` FFmpeg — **pitch suara tetap normal**, tidak berubah seperti `playbackRate`. Untuk nilai > 2.0x atau < 0.5x, otomatis dipecah jadi beberapa filter `atempo` yang di-chain (misal 2.3x → `atempo=2.0,atempo=1.15`).
- **Amplifikasi** (-20 dB – +6 dB): filter `volume=<n>dB`.
- **Durasi maks** (60s – 1200s): memotong output dengan `-t <durasi>`, diterapkan **setelah** speed-up.
- Preset kecepatan: Lambat (2.1x), Default (2.3x), Cepat (2.5x), Lebih Cepat (2.7x), Ultra (2.9x).
- Output: **OGG Vorbis** (kompatibel Roblox) dan **MP3**.
- Upload MP3 lokal atau ambil audio dari YouTube (via Cobalt API, diproses di browser lalu dikirim ke server).
- File upload & hasil otomatis dihapus (hasil setelah 15 menit).

## Instalasi

```bash
npm install
```

Pastikan **FFmpeg** terinstal di sistem dan tersedia di PATH:

```bash
ffmpeg -version
```

## Menjalankan

```bash
npm start
```

Server berjalan di `http://localhost:3000` (atau `process.env.PORT`).

## Struktur

```
audioshift-server/
├── server.js          # Express app utama
├── ffmpegHelper.js     # Logika atempo chaining, volume, trim, validasi
├── routes/
│   └── convert.js      # POST /api/convert, GET /api/defaults
├── public/              # Frontend statis (index.html, style.css, script.js)
├── uploads/             # File upload sementara (auto-cleanup)
└── outputs/             # Hasil konversi (auto-cleanup 15 menit)
```

## API

### `GET /api/defaults`
Mengembalikan nilai default & batas slider:
```json
{
  "ok": true,
  "default": { "speed": 2.3, "gainDb": -4, "maxDur": 400 },
  "limits": {
    "speed":  { "min": 0.5,  "max": 4 },
    "gainDb": { "min": -20,  "max": 6 },
    "maxDur": { "min": 60,   "max": 1200 }
  },
  "presets": { "lambat": 2.1, "default": 2.3, "cepat": 2.5, "lebih_cepat": 2.7, "ultra": 2.9 }
}
```

### `POST /api/convert`
`multipart/form-data`:
- `file` — file audio (MP3/OGG/WAV, maks 20 MB)
- `speed` — faktor kecepatan (default 2.3)
- `gainDb` — gain dalam dB (default -4)
- `maxDur` — durasi maks dalam detik (default 400)

Respons:
```json
{
  "ok": true,
  "settings": { "speed": 2.3, "gainDb": -4, "maxDur": 400 },
  "durations": { "input": 119.98, "output": 52.13 },
  "ogg": { "url": "/outputs/<id>.ogg", "size": 1398368, "codec": "OGG Vorbis (Roblox-compatible)" },
  "mp3": { "url": "/outputs/<id>.mp3", "size": 835126, "codec": "MP3 (libmp3lame)" }
}
```

## Deploy

Bisa dideploy ke platform yang mendukung FFmpeg, misalnya:
- Render / Railway (tambahkan buildpack/apt yang menginstal `ffmpeg`)
- VPS apapun dengan Node.js + FFmpeg terinstal

Untuk Docker, contoh `Dockerfile`:
```dockerfile
FROM node:18-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```
