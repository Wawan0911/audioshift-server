/* =====================================================
   ffmpegHelper.js
   Logika konversi audio dengan FFmpeg:
   - Kecepatan + Pitch ikut naik/turun (efek tape/vinyl)
     via asetrate=44100*speed + aresample=44100
   - Amplifikasi (volume filter, dB)
   - Durasi maks (trim dengan -t)
   - Metadata dihapus total agar tidak ditolak Roblox:
     -map_metadata -1 + eksplisit kosongkan tiap field
     (karena -map_metadata -1 saja tidak cukup untuk
      membersihkan Vorbis Comment block di dalam OGG)
===================================================== */

const ffmpeg = require('fluent-ffmpeg');

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

const DEFAULT_SETTINGS = {
  speed: 2.5,   // ← diubah dari 2.3 ke 2.5
  gainDb: -4,
  maxDur: 400,
};

const SPEED_PRESETS = {
  lambat: 2.1,
  default: 2.5, // ← diubah dari 2.3 ke 2.5
  cepat: 2.5,
  lebih_cepat: 2.7,
  ultra: 2.9,
};

const LIMITS = {
  speed: { min: 0.5, max: 4 },
  gainDb: { min: -20, max: 6 },
  maxDur: { min: 60, max: 1200 },
};

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

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

function buildAudioFilter(speed, gainDb) {
  const targetRate = round6(44100 * speed);
  const filters = [
    `asetrate=${targetRate}`,
    'aresample=44100',
    `volume=${gainDb}dB`,
  ];
  return filters.join(',');
}

function convertAudio(inputPath, outputPath, settings, onProgress) {
  const { speed, gainDb, maxDur } = settings;
  const audioFilter = buildAudioFilter(speed, gainDb);
  const ext = outputPath.split('.').pop().toLowerCase();

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath)
      .audioFilters(audioFilter.split(','))
      .outputOptions([
        '-t', String(maxDur),

        // Hapus metadata: -map_metadata -1 saja tidak cukup untuk OGG
        // karena tag artist/title tertanam di Vorbis Comment block.
        // Solusi: kombinasi -map_metadata -1 + eksplisit kosongkan tiap field.
        '-map_metadata', '-1',
        '-metadata', 'title=',
        '-metadata', 'artist=',
        '-metadata', 'album=',
        '-metadata', 'comment=',
        '-metadata', 'genre=',
        '-metadata', 'date=',
        '-metadata', 'track=',
        '-metadata', 'composer=',
        '-metadata', 'copyright=',
        '-metadata', 'description=',
      ]);

    if (ext === 'ogg') {
      command = command
        .audioCodec('libvorbis')
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
