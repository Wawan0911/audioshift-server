/* =====================================================
   convert.js — Route untuk konversi audio (async/background)
   - POST /api/convert       -> upload file, langsung balas { jobId } (cepat, tidak menunggu FFmpeg)
   - GET  /api/status/:jobId -> cek status job: pending | done | error
   - GET  /api/defaults      -> nilai default & batas slider

   Pola ini menghindari timeout proxy (misal Back4App) untuk file
   audio yang panjang, karena FFmpeg berjalan di background setelah
   response awal dikirim. Client melakukan polling status secara periodik.
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
 * In-memory job store.
 * jobs[jobId] = {
 *   status: 'pending' | 'done' | 'error',
 *   progress: number (0-100, perkiraan),
 *   error: string | null,
 *   settings, durations, ogg, mp3
 * }
 *
 * Catatan: in-memory berarti job hilang kalau server restart.
 * Untuk skala kecil/personal ini cukup; untuk produksi besar
 * sebaiknya pakai Redis/DB.
 */
const jobs = new Map();

const JOB_TTL_MS = 20 * 60 * 1000; // 20 menit — job & file dibersihkan setelah ini

function scheduleCleanup(jobId, filePaths, delayMs = 15 * 60 * 1000) {
  setTimeout(() => {
    for (const p of filePaths) {
      if (p) fs.unlink(p, () => {});
    }
  }, delayMs);
  // Hapus entry job dari memori setelah TTL agar tidak menumpuk
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
}

/**
 * Proses konversi di background. Tidak di-await oleh route handler.
 */
async function processJob(jobId, inputPath, settings) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    const inputDuration = await getDuration(inputPath);

    const oggPath = path.join(OUTPUT_DIR, `${jobId}.ogg`);
    const mp3Path = path.join(OUTPUT_DIR, `${jobId}.mp3`);

    // OGG dan MP3 diproses paralel untuk mempercepat total waktu
    await Promise.all([
      convertAudio(inputPath, oggPath, settings, (pct) => {
        const val = Math.round((pct || 0) * 0.5);
        job.progress = Math.max(job.progress || 0, Number.isFinite(val) ? val : 0);
      }),
      convertAudio(inputPath, mp3Path, settings, (pct) => {
        const val = 50 + Math.round((pct || 0) * 0.5);
        job.progress = Math.max(job.progress || 0, Number.isFinite(val) ? val : 0);
      }),
    ]);

    const oggStat = fs.statSync(oggPath);
    const mp3Stat = fs.statSync(mp3Path);
    const outputDuration = await getDuration(oggPath);

    fs.unlink(inputPath, () => {});

    job.status = 'done';
    job.progress = 100;
    job.durations = { input: inputDuration, output: outputDuration };
    job.ogg = { url: `/outputs/${jobId}.ogg`, size: oggStat.size, codec: 'OGG Vorbis (Roblox-compatible)' };
    job.mp3 = { url: `/outputs/${jobId}.mp3`, size: mp3Stat.size, codec: 'MP3 (libmp3lame)' };

    scheduleCleanup(jobId, [oggPath, mp3Path]);
  } catch (err) {
    console.error(`[convert] job ${jobId} error:`, err.message);
    fs.unlink(inputPath, () => {});
    job.status = 'error';
    job.error = err.message || 'Terjadi kesalahan saat konversi.';
    setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
  }
}

/**
 * POST /api/convert
 * Menerima upload file + parameter, langsung balas { ok, jobId } TANPA
 * menunggu FFmpeg selesai. Proses konversi berjalan di background.
 */
router.post('/convert', upload.single('file'), async (req, res) => {
  const inputPath = req.file?.path;

  try {
    if (!inputPath) {
      return res.status(400).json({ ok: false, error: 'File audio tidak ditemukan dalam request.' });
    }

    const settings = validateSettings({
      speed: req.body.speed,
      gainDb: req.body.gainDb,
      maxDur: req.body.maxDur,
    });

    const jobId = uuidv4();
    jobs.set(jobId, {
      status: 'pending',
      progress: 0,
      error: null,
      settings,
      durations: null,
      ogg: null,
      mp3: null,
    });

    // Jalankan di background — TIDAK di-await
    processJob(jobId, inputPath, settings);

    return res.json({ ok: true, jobId, settings });
  } catch (err) {
    if (inputPath) fs.unlink(inputPath, () => {});
    console.error('[convert] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'Terjadi kesalahan saat memproses upload.' });
  }
});

/**
 * GET /api/status/:jobId
 * Polling status job konversi.
 */
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job tidak ditemukan atau sudah dibersihkan (kadaluarsa setelah 20 menit).' });
  }

  if (job.status === 'error') {
    return res.json({ ok: false, status: 'error', error: job.error });
  }

  if (job.status === 'done') {
    return res.json({
      ok: true,
      status: 'done',
      settings: job.settings,
      durations: job.durations,
      ogg: job.ogg,
      mp3: job.mp3,
    });
  }

  return res.json({ ok: true, status: 'pending', progress: job.progress });
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
