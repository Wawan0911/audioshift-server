/* =====================================================
   convert.js — Route untuk konversi audio
   POST /api/convert
     - multipart/form-data: file (mp3), speed, gainDb, maxDur
     - response: { ok, oggUrl, mp3Url, durations, codec }
===================================================== */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const {
  convertAudio,
  getDuration,
  validateSettings,
  DEFAULT_SETTINGS,
} = require('../ffmpegHelper');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'outputs');
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — sama seperti batas UI

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.mp3';
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav'];
    if (allowed.includes(file.mimetype) || /\.(mp3|ogg|wav)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan MP3.'));
    }
  },
});

/**
 * Hapus file setelah delay tertentu (cleanup otomatis).
 */
function scheduleCleanup(filePaths, delayMs = 15 * 60 * 1000) {
  setTimeout(() => {
    for (const p of filePaths) {
      fs.unlink(p, () => {});
    }
  }, delayMs);
}

router.post('/convert', upload.single('file'), async (req, res) => {
  const inputPath = req.file?.path;

  try {
    if (!inputPath) {
      return res.status(400).json({ ok: false, error: 'File audio tidak ditemukan dalam request.' });
    }

    // Validasi & normalisasi parameter (default mengikuti AudioShift: speed 2.3x, gain -4dB, maxDur 400s)
    const settings = validateSettings({
      speed: req.body.speed,
      gainDb: req.body.gainDb,
      maxDur: req.body.maxDur,
    });

    const inputDuration = await getDuration(inputPath);

    const jobId = uuidv4();
    const oggPath = path.join(OUTPUT_DIR, `${jobId}.ogg`);
    const mp3Path = path.join(OUTPUT_DIR, `${jobId}.mp3`);

    // Konversi ke OGG Vorbis (utama, untuk Roblox) & MP3 (alternatif) secara PARALEL
    // untuk mengurangi total waktu proses ~50% (penting untuk platform dengan timeout pendek seperti Back4App)
    await Promise.all([
      convertAudio(inputPath, oggPath, settings),
      convertAudio(inputPath, mp3Path, settings),
    ]);

    const oggStat = fs.statSync(oggPath);
    const mp3Stat = fs.statSync(mp3Path);
    const outputDuration = await getDuration(oggPath);

    // Cleanup: hapus file input segera, file output setelah 15 menit
    fs.unlink(inputPath, () => {});
    scheduleCleanup([oggPath, mp3Path]);

    return res.json({
      ok: true,
      settings,
      durations: {
        input: inputDuration,
        output: outputDuration,
      },
      ogg: {
        url: `/outputs/${jobId}.ogg`,
        size: oggStat.size,
        codec: 'OGG Vorbis (Roblox-compatible)',
      },
      mp3: {
        url: `/outputs/${jobId}.mp3`,
        size: mp3Stat.size,
        codec: 'MP3 (libmp3lame)',
      },
    });
  } catch (err) {
    if (inputPath) fs.unlink(inputPath, () => {});
    console.error('[convert] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Terjadi kesalahan saat konversi.' });
  }
});

/**
 * GET /api/defaults — kirim nilai default & batas slider ke frontend
 * agar UI dan backend selalu konsisten.
 */
router.get('/defaults', (req, res) => {
  const { LIMITS, SPEED_PRESETS } = require('../ffmpegHelper');
  res.json({ ok: true, default: DEFAULT_SETTINGS, limits: LIMITS, presets: SPEED_PRESETS });
});

module.exports = router;
