/* =====================================================
   ffmpegHelper.js
   Logika konversi audio dengan FFmpeg:
   - Kecepatan (atempo, pitch tetap normal — chaining untuk >2.0x atau <0.5x)
   - Amplifikasi (volume filter, dB)
   - Durasi maks (trim dengan -t)
===================================================== */

const ffmpeg = require('fluent-ffmpeg');

/**
 * Memecah nilai speed menjadi rangkaian filter atempo yang valid.
 * Filter `atempo` FFmpeg hanya menerima rentang 0.5 - 2.0 per instance,
 * jadi nilai di luar rentang itu harus di-chain.
 *
 * Contoh:
 *   2.3  -> ["atempo=2.0", "atempo=1.15"]   (2.0 * 1.15 = 2.3)
 *   0.25 -> ["atempo=0.5",  "atempo=0.5"]   (0.5 * 0.5  = 0.25)
 *
 * @param {number} speed - faktor kecepatan (misal 2.3 untuk 2.3x)
 * @returns {string[]} array string filter atempo
 */
function buildAtempoChain(speed) {
  const MIN = 0.5;
  const MAX = 2.0;
  const stages = [];
  let remaining = speed;

  if (remaining <= 0) {
    throw new Error('Nilai kecepatan harus lebih besar dari 0.');
  }

  // Pecah nilai > 2.0 menjadi beberapa tahap x2.0
  while (remaining > MAX) {
    stages.push(MAX);
    remaining /= MAX;
  }
  // Pecah nilai < 0.5 menjadi beberapa tahap x0.5
  while (remaining < MIN) {
    stages.push(MIN);
    remaining /= MIN;
  }
  // Sisa terakhir
  stages.push(round6(remaining));

  return stages.map(v => `atempo=${v}`);
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Konfigurasi preset bawaan (sesuai default AudioShift).
 * speed   : faktor kecepatan (pitch tetap normal via atempo)
 * gainDb  : penguatan/pelemahan volume dalam dB
 * maxDur  : durasi maksimum output dalam detik (trim jika lebih panjang)
 */
const DEFAULT_SETTINGS = {
  speed: 2.3,
  gainDb: -4,
  maxDur: 400,
};

/**
 * Preset kecepatan yang ditampilkan di UI (Lambat, Default, Cepat, dst.)
 */
const SPEED_PRESETS = {
  lambat: 2.1,
  default: 2.3,
  cepat: 2.5,
  lebih_cepat: 2.7,
  ultra: 2.9,
};

/**
 * Batas validasi input (mengikuti rentang slider di UI)
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
 * Membangun filter audio FFmpeg lengkap: asetrate + atempo (speed) + volume (gain).
 *
 * CATATAN PENTING — meniru perilaku cenzstudio:
 * Filter dimulai dengan `asetrate=44100` SEBELUM `atempo`. Untuk file
 * dengan sample rate asli BUKAN 44100Hz (misal 48000Hz, umum untuk
 * audio dari YouTube/MP3 modern), `asetrate=44100` membuat decoder
 * memutar data sample pada rate 44100 (lebih rendah dari aslinya),
 * sehingga audio terdengar SEDIKIT LEBIH CEPAT & pitch turun
 * (~1.47 semitone untuk source 48kHz) SEBELUM atempo diterapkan.
 *
 * Hasil akhir: speed efektif ≈ speed_input * (sample_rate_asli / 44100).
 * Contoh terverifikasi: input 48kHz, speed=2.3 -> speed efektif ≈ 2.113x
 * (253.56s -> ~119.97s), match dengan output cenzstudio.
 *
 * Untuk input yang SUDAH 44100Hz, asetrate=44100 tidak mengubah apapun
 * (speed efektif = speed_input persis, pitch tetap normal).
 *
 * Ini SENGAJA dipertahankan agar hasil identik dengan cenzstudio,
 * meskipun untuk source non-44.1kHz bukan "pitch tetap normal murni".
 *
 * @param {number} speed
 * @param {number} gainDb
 * @returns {string} filter string siap pakai untuk -filter:a / .audioFilters
 */
function buildAudioFilter(speed, gainDb) {
  const atempoChain = buildAtempoChain(speed);
  const filters = ['asetrate=44100', ...atempoChain, `volume=${gainDb}dB`];
  return filters.join(',');
}

/**
 * Menjalankan konversi audio dengan FFmpeg.
 *
 * @param {string} inputPath  - path file input
 * @param {string} outputPath - path file output (ekstensi menentukan format: .ogg / .mp3)
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
      // Durasi maks dihitung pada OUTPUT (setelah speed-up).
      // FFmpeg -t memotong stream output, jadi diterapkan setelah filter atempo.
      .outputOptions(['-t', String(maxDur)]);

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
  buildAtempoChain,
  buildAudioFilter,
  convertAudio,
  getDuration,
  validateSettings,
  DEFAULT_SETTINGS,
  SPEED_PRESETS,
  LIMITS,
};
