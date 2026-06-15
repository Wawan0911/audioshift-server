/* =====================================================
   ffmpegHelper.js
   Logika konversi audio dengan FFmpeg:
   - Kecepatan + Pitch ikut naik/turun (efek tape/vinyl)
     via asetrate=44100*speed + aresample=44100
   - Amplifikasi (volume filter, dB)
   - Durasi maks (trim dengan -t)
   - Metadata dihapus (-map_metadata -1) agar tidak ditolak Roblox
===================================================== */

const ffmpeg = require('fluent-ffmpeg');

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Konfigurasi preset bawaan.
 * speed   : faktor kecepatan (pitch IKUT naik/turun — efek tape)
 * gainDb  : penguatan/pelemahan volume dalam dB
 * maxDur  : durasi maksimum output dalam detik (trim jika lebih panjang)
 */
const DEFAULT_SETTINGS = {
  speed: 2.3,
  gainDb: -4,
  maxDur: 400,
};

/**
 * Preset kecepatan yang ditampilkan di UI
 */
const SPEED_PRESETS = {
  lambat: 2.1,
  default: 2.3,
  cepat: 2.5,
  lebih_cepat: 2.7,
  ultra: 2.9,
};

/**
 * Batas validasi input
 */
const LIMITS = {
  speed: { min: 0.5, max: 4 },
  gainDb: { min: -20, max: 6 },
  maxDur: { min: 60, max: 1200 },
};

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Validasi & normalisasi parameter dari request.
 * @param {object} opts - { speed, gainDb, maxDur }
 * @returns {object} parameter yang sudah divalidasi
 */
function validateSettings(opts = {}) {
  const speed = clamp(
    parseFloat(opts.speed ?? DEFAULT_SETTINGS.speed),
    LIMITS.speed.min,
    LIMITS.speed.max
  );
  const gainDb = clamp(
    parseFloat(opts.gainDb ?? DEFAULT_SETTINGS.gainDb),
    LIMITS.gainDb.min,
    LIMITS.gainDb.max
  );
  const maxDur = clamp(
    parseInt(opts.maxDur ?? DEFAULT_SETTINGS.maxDur, 10),
    LIMITS.maxDur.min,
    LIMITS.maxDur.max
  );

  if (Number.isNaN(speed) || Number.isNaN(gainDb) || Number.isNaN(maxDur)) {
    throw new Error('Parameter speed, gainDb, atau maxDur tidak valid.');
  }

  return { speed, gainDb, maxDur };
}

/**
 * Membangun filter audio FFmpeg untuk efek tape/vinyl:
 * pitch IKUT naik/turun sesuai kecepatan.
 *
 * Cara kerja:
 *   1. `asetrate=N` — mengubah sample rate yang dilaporkan ke decoder
 *      tanpa mengubah data sample. Jika N > rate asli, audio dimainkan
 *      lebih cepat DAN pitch naik (persis seperti memutar kaset lebih cepat).
 *   2. `aresample=44100` — resample output ke 44100Hz agar codec
 *      (libvorbis / libmp3lame) mendapat sample rate standar.
 *   3. `volume=XdB` — amplifikasi akhir.
 *
 * Rumus: asetrate = 44100 * speed
 *   speed=2.3  → asetrate=101430  → 2.3× lebih cepat, pitch naik ~1.2 oktaf
 *   speed=0.5  → asetrate=22050   → 0.5× lebih lambat, pitch turun ~1 oktaf
 *
 * @param {number} speed
 * @param {number} gainDb
 * @returns {string} filter string siap pakai
 */
function buildAudioFilter(speed, gainDb) {
  const targetRate = round6(44100 * speed);
  const filters = [
    `asetrate=${targetRate}`,
    'aresample=44100',
    `volume=${gainDb}dB`,
  ];
  return filters.join(',');
}

/**
 * Menjalankan konversi audio dengan FFmpeg.
 *
 * @param {string} inputPath  - path file input
 * @param {string} outputPath - path file output (.ogg / .mp3)
 * @param {object} settings   - { speed, gainDb, maxDur } (sudah divalidasi)
 * @param {function} onProgress - callback opsional (percent: number) => void
 * @returns {Promise<void>}
 */
function convertAudio(inputPath, outputPath, settings, onProgress) {
  const { speed, gainDb, maxDur } = settings;
  const audioFilter = buildAudioFilter(speed, gainDb);
  const ext = outputPath.split('.').pop().toLowerCase();

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath)
      .audioFilters(audioFilter.split(','))
      .outputOptions([
        '-t', String(maxDur),
        '-map_metadata', '-1',  // Hapus semua metadata agar tidak ditolak Roblox
      ]);

    if (ext === 'ogg') {
      command = command
        .audioCodec('libvorbis')   // OGG Vorbis — kompatibel dengan Roblox
        .audioChannels(2)
        .audioFrequency(44100)
        .audioBitrate('192k')
        .format('ogg');
    } else if (ext === 'mp3') {
      command = command
        .audioCodec('libmp3lame')
        .audioChannels(2)
        .audioFrequency(44100)
        .audioBitrate('128k')
        .format('mp3');
    } else {
      return reject(new Error(`Format output tidak didukung: .${ext}`));
    }

    command
      .on('start', (cmd) => {
        console.log('[ffmpeg] command:', cmd);
      })
      .on('progress', (progress) => {
        if (onProgress && typeof progress.percent === 'number') {
          onProgress(Math.min(100, Math.max(0, progress.percent)));
        }
      })
      .on('error', (err) => {
        reject(err);
      })
      .on('end', () => {
        resolve();
      })
      .save(outputPath);
  });
}

/**
 * Mengambil durasi audio (dalam detik) menggunakan ffprobe.
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata?.format?.duration;
      if (typeof duration !== 'number') {
        return reject(new Error('Tidak dapat membaca durasi audio.'));
      }
      resolve(duration);
    });
  });
}

module.exports = {
  buildAudioFilter,
  convertAudio,
  getDuration,
  validateSettings,
  DEFAULT_SETTINGS,
  SPEED_PRESETS,
  LIMITS,
};
