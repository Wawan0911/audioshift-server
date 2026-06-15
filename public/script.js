/* =====================================================
   AudioShift – script.js  (v4 — Server FFmpeg edition)
   Perubahan dari v3:
   - Konversi (speed/atempo, gain/volume, trim durasi) dilakukan
     di backend Node.js menggunakan FFmpeg, BUKAN di browser.
   - Speed memakai filter `atempo` (pitch tetap normal, sama
     seperti cenzstudio) — bukan playbackRate (yang mengubah pitch).
   - Output selalu OGG Vorbis (Roblox-compatible) + MP3 dari server.
   - Preview tetap di browser (Web Audio API) untuk UX cepat,
     tapi TIDAK memengaruhi hasil akhir — hasil akhir 100% dari FFmpeg.
===================================================== */

/* ── Konstanta ── */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const COBALT_INSTANCES = [
  'https://cobalt.canine.tools',
  'https://cobalt.drgns.space',
  'https://cob.froth.zone',
  'https://cobalt.lunar.icu',
  'https://cobalt.api.benny.fun',
];

// Default sesuai backend (lihat ffmpegHelper.js) — akan disinkron via /api/defaults
let DEFAULT = { speed: 2.3, gainDb: -4, maxDur: 400 };
let LIMITS   = {
  speed:  { min: 0.5, max: 4 },
  gainDb: { min: -20, max: 6 },
  maxDur: { min: 60, max: 1200 },
};

/* ── State ── */
let sourceMode   = null;
let audioFile    = null;
let ytAudioUrl   = null;
let ytVideoTitle = '';
let activeInstance = null;
let settingsMode = 'default';
let previewAudioCtx = null;
let previewSource   = null;
let previewBuffer   = null;
let isPreviewPlaying = false;
let previewStartTime = 0;
let previewOffset    = 0;
let previewAnimId    = null;

/* ── DOM ── */
const audioInput       = document.getElementById('audioInput');
const dropArea         = document.getElementById('dropArea');
const fileInfo         = document.getElementById('fileInfo');
const ytUrlInput       = document.getElementById('ytUrl');
const ytLoadBtn        = document.getElementById('ytLoadBtn');
const ytPreview        = document.getElementById('ytPreview');
const ytStatus         = document.getElementById('ytStatus');
const instanceInfo     = document.getElementById('instanceInfo');
const instanceInfoText = document.getElementById('instanceInfoText');
const btnDefault       = document.getElementById('btnDefault');
const btnCustom        = document.getElementById('btnCustom');
const defaultSettings  = document.getElementById('defaultSettings');
const customSettings   = document.getElementById('customSettings');
const slSpeed          = document.getElementById('slSpeed');
const slGain           = document.getElementById('slGain');
const slDur            = document.getElementById('slDur');
const numSpeed         = document.getElementById('numSpeed');
const numGain          = document.getElementById('numGain');
const numDur           = document.getElementById('numDur');
const convertBtn       = document.getElementById('convertBtn');
const progressWrap     = document.getElementById('progressWrap');
const progressFill     = document.getElementById('progressFill');
const progressLabel    = document.getElementById('progressLabel');
const downloadSection  = document.getElementById('downloadSection');
const dlOgg            = document.getElementById('dlOgg');
const dlMp3            = document.getElementById('dlMp3');
const dlNote           = document.getElementById('dlNote');
const dlSize           = document.getElementById('dlSize');
const globalStatus     = document.getElementById('globalStatus');

/* ── Sinkronisasi default & limit dari backend ── */
(async function syncDefaultsFromServer() {
  try {
    const res = await fetch('/api/defaults');
    const data = await res.json();
    if (data.ok) {
      DEFAULT = data.default;
      LIMITS  = data.limits;
      applyLimitsToInputs();
      updateDefaultSettingsUI();
    }
  } catch (e) {
    // Backend belum tersedia saat load awal — pakai nilai default lokal
  }
})();

function applyLimitsToInputs() {
  if (slSpeed) { slSpeed.min = LIMITS.speed.min; slSpeed.max = LIMITS.speed.max; }
  if (numSpeed) { numSpeed.min = LIMITS.speed.min; numSpeed.max = LIMITS.speed.max; }
  if (slGain) { slGain.min = LIMITS.gainDb.min; slGain.max = LIMITS.gainDb.max; }
  if (numGain) { numGain.min = LIMITS.gainDb.min; numGain.max = LIMITS.gainDb.max; }
  if (slDur) { slDur.min = LIMITS.maxDur.min; slDur.max = LIMITS.maxDur.max; }
  if (numDur) { numDur.min = LIMITS.maxDur.min; numDur.max = LIMITS.maxDur.max; }
}

function updateDefaultSettingsUI() {
  const cards = defaultSettings.querySelectorAll('.setting-value');
  if (cards.length >= 3) {
    cards[0].textContent = `${DEFAULT.speed}×`;
    cards[1].textContent = `${DEFAULT.gainDb} dB`;
    cards[2].textContent = `${DEFAULT.maxDur} s`;
  }
}

/* ── Helpers ── */
function setProgress(pct, label) {
  progressFill.style.width = pct + '%';
  progressLabel.textContent = label;
}
function showStatus(msg, isError = false) {
  globalStatus.textContent = msg;
  globalStatus.style.color = isError ? '#b91c1c' : '#6b7280';
}
function clearStatus() { globalStatus.textContent = ''; }
function readyToConvert() {
  convertBtn.disabled = (sourceMode === null);
}
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
function sanitizeName(str) {
  return str.replace(/[^a-zA-Z0-9\-_\u00C0-\u024F\u0400-\u04FF]/g, '_').slice(0, 60);
}

/* ── Settings mode toggle ── */
btnDefault.addEventListener('click', () => {
  settingsMode = 'default';
  btnDefault.classList.add('active');
  btnCustom.classList.remove('active');
  defaultSettings.classList.remove('hidden');
  customSettings.classList.add('hidden');
});
btnCustom.addEventListener('click', () => {
  settingsMode = 'custom';
  btnCustom.classList.add('active');
  btnDefault.classList.remove('active');
  customSettings.classList.remove('hidden');
  defaultSettings.classList.add('hidden');
});

/* ── Preset cepat (Lambat 2.1x, Default 2.3x, Cepat 2.5x, dst.) ── */
document.querySelectorAll('[data-preset-speed]').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = parseFloat(btn.dataset.presetSpeed);
    slSpeed.value = v;
    if (numSpeed) numSpeed.value = v.toFixed(1);
    document.querySelectorAll('.preset-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});


/* ── Two-way sync slider ↔ number input ── */
slSpeed.addEventListener('input', () => {
  if (numSpeed) numSpeed.value = parseFloat(slSpeed.value).toFixed(1);
  const v = parseFloat(slSpeed.value).toFixed(1);
  document.querySelectorAll('.preset-pill').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.presetSpeed).toFixed(1) === v);
  });
});
if (numSpeed) {
  numSpeed.addEventListener('input', () => { let v = parseFloat(numSpeed.value); if (!isNaN(v)) slSpeed.value = clamp(v, LIMITS.speed.min, LIMITS.speed.max); });
  numSpeed.addEventListener('change', () => { let v = parseFloat(numSpeed.value); if (isNaN(v)) v = 1.0; v = clamp(parseFloat(v.toFixed(1)), LIMITS.speed.min, LIMITS.speed.max); numSpeed.value = v.toFixed(1); slSpeed.value = v; });
}
document.getElementById('stepSpeedDown')?.addEventListener('click', () => { let v = Math.round((clamp(parseFloat(slSpeed.value) - 0.1, LIMITS.speed.min, LIMITS.speed.max)) * 10) / 10; slSpeed.value = v; if (numSpeed) numSpeed.value = v.toFixed(1); });
document.getElementById('stepSpeedUp')?.addEventListener('click', () => { let v = Math.round((clamp(parseFloat(slSpeed.value) + 0.1, LIMITS.speed.min, LIMITS.speed.max)) * 10) / 10; slSpeed.value = v; if (numSpeed) numSpeed.value = v.toFixed(1); });

slGain.addEventListener('input', () => { if (numGain) numGain.value = parseInt(slGain.value); });
if (numGain) {
  numGain.addEventListener('input', () => { let v = parseInt(numGain.value); if (!isNaN(v)) slGain.value = clamp(v, LIMITS.gainDb.min, LIMITS.gainDb.max); });
  numGain.addEventListener('change', () => { let v = parseInt(numGain.value); if (isNaN(v)) v = 0; v = clamp(v, LIMITS.gainDb.min, LIMITS.gainDb.max); numGain.value = v; slGain.value = v; });
}
document.getElementById('stepGainDown')?.addEventListener('click', () => { const v = clamp(parseInt(slGain.value) - 1, LIMITS.gainDb.min, LIMITS.gainDb.max); slGain.value = v; if (numGain) numGain.value = v; });
document.getElementById('stepGainUp')?.addEventListener('click', () => { const v = clamp(parseInt(slGain.value) + 1, LIMITS.gainDb.min, LIMITS.gainDb.max); slGain.value = v; if (numGain) numGain.value = v; });

slDur.addEventListener('input', () => { if (numDur) numDur.value = parseInt(slDur.value); });
if (numDur) {
  numDur.addEventListener('input', () => { let v = parseInt(numDur.value); if (!isNaN(v)) slDur.value = clamp(v, LIMITS.maxDur.min, LIMITS.maxDur.max); });
  numDur.addEventListener('change', () => { let v = parseInt(numDur.value); if (isNaN(v)) v = 600; v = clamp(v, LIMITS.maxDur.min, LIMITS.maxDur.max); numDur.value = v; slDur.value = v; });
}
document.getElementById('stepDurDown')?.addEventListener('click', () => { const v = clamp(parseInt(slDur.value) - 1, LIMITS.maxDur.min, LIMITS.maxDur.max); slDur.value = v; if (numDur) numDur.value = v; });
document.getElementById('stepDurUp')?.addEventListener('click', () => { const v = clamp(parseInt(slDur.value) + 1, LIMITS.maxDur.min, LIMITS.maxDur.max); slDur.value = v; if (numDur) numDur.value = v; });

/* ── File upload ── */
audioInput.addEventListener('change', () => { const f = audioInput.files[0]; if (f) handleFileSelect(f); });
dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
dropArea.addEventListener('drop', e => {
  e.preventDefault(); dropArea.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type === 'audio/mpeg') handleFileSelect(f);
  else showStatus('Hanya file MP3 yang didukung.', true);
});

function handleFileSelect(f) {
  if (f.size > MAX_FILE_BYTES) { showStatus(`File terlalu besar: ${formatBytes(f.size)}. Maks 20 MB.`, true); audioInput.value = ''; return; }
  setFile(f);
}

async function setFile(f) {
  audioFile  = f;
  sourceMode = 'file';
  ytAudioUrl = null;
  ytPreview.classList.add('hidden');
  ytStatus.textContent = '';
  ytUrlInput.value = '';
  instanceInfo.classList.add('hidden');
  fileInfo.classList.remove('hidden');
  fileInfo.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    <span>${f.name} (${formatBytes(f.size)})</span>`;
  downloadSection.classList.add('hidden');
  clearStatus();
  readyToConvert();
  // Load preview (browser-side, hanya untuk visualisasi/listen — tidak dipakai di hasil akhir)
  const ab = await f.arrayBuffer();
  await loadPreview(ab);
}

/* ── Audio Preview (browser-side, hanya untuk UX) ── */
async function loadPreview(arrayBuffer) {
  try {
    stopPreview();
    if (previewAudioCtx) { try { previewAudioCtx.close(); } catch (e) {} }
    previewAudioCtx = new AudioContext();
    previewBuffer   = await previewAudioCtx.decodeAudioData(arrayBuffer.slice(0));
    showPreviewUI();
    drawWaveform(previewBuffer);
  } catch (e) {
    // preview gagal, tidak apa-apa — tidak memengaruhi konversi
  }
}

function showPreviewUI() {
  const sec = document.getElementById('previewSection');
  if (sec) sec.classList.remove('hidden');
  updatePreviewBtn(false);
}

function updatePreviewBtn(playing) {
  const btn = document.getElementById('previewPlayBtn');
  if (!btn) return;
  btn.innerHTML = playing
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Preview`;
}

function playPreview() {
  if (!previewBuffer || !previewAudioCtx) return;
  if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume();
  stopPreview();
  previewSource = previewAudioCtx.createBufferSource();
  previewSource.buffer = previewBuffer;
  previewSource.connect(previewAudioCtx.destination);
  previewSource.start(0, previewOffset);
  previewStartTime = previewAudioCtx.currentTime - previewOffset;
  isPreviewPlaying = true;
  updatePreviewBtn(true);
  previewSource.onended = () => {
    if (isPreviewPlaying) { isPreviewPlaying = false; previewOffset = 0; updatePreviewBtn(false); updatePreviewProgress(0); cancelAnimationFrame(previewAnimId); }
  };
  animatePreview();
}

function stopPreview() {
  if (previewSource) { try { previewSource.stop(); } catch (e) {} previewSource = null; }
  isPreviewPlaying = false;
  cancelAnimationFrame(previewAnimId);
  updatePreviewBtn(false);
}

function animatePreview() {
  previewAnimId = requestAnimationFrame(() => {
    if (!isPreviewPlaying || !previewAudioCtx || !previewBuffer) return;
    const elapsed = previewAudioCtx.currentTime - previewStartTime;
    const pct = Math.min(1, elapsed / previewBuffer.duration);
    updatePreviewProgress(pct);
    if (pct < 1) animatePreview();
  });
}

function updatePreviewProgress(pct) {
  const bar = document.getElementById('previewProgressBar');
  const time = document.getElementById('previewTime');
  if (bar) bar.style.width = (pct * 100) + '%';
  if (time && previewBuffer) {
    const cur = pct * previewBuffer.duration;
    time.textContent = fmtTime(cur) + ' / ' + fmtTime(previewBuffer.duration);
  }
}

function drawWaveform(buffer) {
  const canvas = document.getElementById('waveformCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / W);
  const mid  = H / 2;

  ctx.beginPath();
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] || 0;
      if (v < min) min = v; if (v > max) max = v;
    }
    ctx.moveTo(x, mid + min * mid * 0.85);
    ctx.lineTo(x, mid + max * mid * 0.85);
  }
  ctx.stroke();
}

document.addEventListener('click', e => {
  const btn = e.target.closest('#previewPlayBtn');
  if (!btn) return;
  if (isPreviewPlaying) stopPreview(); else playPreview();
});

document.addEventListener('click', e => {
  const track = e.target.closest('#previewTrack');
  if (!track || !previewBuffer) return;
  const rect = track.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  previewOffset = clamp(pct * previewBuffer.duration, 0, previewBuffer.duration);
  if (isPreviewPlaying) playPreview(); else updatePreviewProgress(pct);
});

/* ── YouTube – Cobalt multi-instance ── */
function extractYtId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v') || null;
  } catch { return null; }
}

ytLoadBtn.addEventListener('click', loadYoutube);
ytUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadYoutube(); });

async function tryCobaltInstance(baseUrl, videoId) {
  const endpoint = baseUrl.replace(/\/$/, '') + '/';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, downloadMode: 'audio', audioFormat: 'best', audioBitrate: '128' }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'redirect' || data.status === 'tunnel' || data.status === 'stream' || data.url) return { url: data.url, filename: data.filename || `yt_${videoId}` };
  if (data.status === 'local-processing' && data.tunnel && data.tunnel[0]) return { url: data.tunnel[0], filename: data.output?.filename || `yt_${videoId}` };
  if (data.status === 'picker') { const item = data.picker && data.picker.find(i => i.url); if (item) return { url: item.url, filename: data.audioFilename || `yt_${videoId}` }; }
  throw new Error(data.error?.code || data.status || 'Format tidak didukung');
}

async function loadYoutube() {
  const url = ytUrlInput.value.trim();
  if (!url) { ytStatus.textContent = 'Masukkan link YouTube terlebih dahulu.'; return; }
  const videoId = extractYtId(url);
  if (!videoId) { ytStatus.textContent = 'Link tidak dikenali. Gunakan format youtube.com/watch?v=... atau youtu.be/...'; return; }
  ytStatus.textContent = '';
  ytLoadBtn.disabled = true;
  ytPreview.classList.add('hidden');
  instanceInfo.classList.remove('hidden');
  instanceInfoText.textContent = 'Mencari server Cobalt yang tersedia…';
  let lastError = '';
  for (let i = 0; i < COBALT_INSTANCES.length; i++) {
    const inst = COBALT_INSTANCES[i];
    instanceInfoText.textContent = `Mencoba server ${i + 1}/${COBALT_INSTANCES.length}: ${inst.replace('https://', '')}`;
    try {
      const result = await tryCobaltInstance(inst, videoId);
      activeInstance = inst;
      ytAudioUrl    = result.url;
      ytVideoTitle  = result.filename;
      sourceMode    = 'youtube';
      audioFile     = null;
      fileInfo.classList.add('hidden');
      const sec = document.getElementById('previewSection');
      if (sec) sec.classList.add('hidden');
      instanceInfoText.textContent = `✓ Server: ${inst.replace('https://', '')}`;
      ytPreview.classList.remove('hidden');
      ytPreview.innerHTML = `
        <img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg" alt="" onerror="this.style.display='none'">
        <div class="yt-meta">
          <div class="yt-title">${ytVideoTitle}</div>
          <div class="yt-channel">Siap untuk dikonversi</div>
        </div>`;
      ytStatus.textContent = 'Audio berhasil dimuat dari YouTube.';
      ytStatus.style.color = '#15803d';
      downloadSection.classList.add('hidden');
      clearStatus();
      readyToConvert();
      ytLoadBtn.disabled = false;
      return;
    } catch (err) { lastError = err.message; }
  }
  instanceInfo.classList.add('hidden');
  ytStatus.textContent = `Gagal memuat dari semua server. Error terakhir: ${lastError}. Coba lagi nanti atau gunakan file MP3.`;
  ytStatus.style.color = '#b91c1c';
  ytAudioUrl = null;
  if (sourceMode === 'youtube') { sourceMode = null; readyToConvert(); }
  ytLoadBtn.disabled = false;
}

/* ── Konversi (server-side via FFmpeg) ── */
convertBtn.addEventListener('click', startConvert);

async function startConvert() {
  clearStatus();
  downloadSection.classList.add('hidden');
  convertBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  setProgress(5, 'Mempersiapkan audio…');

  let speed, gainDb, maxDur;
  if (settingsMode === 'default') {
    speed = DEFAULT.speed; gainDb = DEFAULT.gainDb; maxDur = DEFAULT.maxDur;
  } else {
    speed  = clamp(parseFloat(numSpeed ? numSpeed.value : slSpeed.value), LIMITS.speed.min, LIMITS.speed.max);
    gainDb = clamp(parseInt(numGain ? numGain.value : slGain.value), LIMITS.gainDb.min, LIMITS.gainDb.max);
    maxDur = clamp(parseInt(numDur ? numDur.value : slDur.value), LIMITS.maxDur.min, LIMITS.maxDur.max);
  }

  try {
    let blob;
    let baseName;

    if (sourceMode === 'file') {
      blob = audioFile;
      baseName = audioFile.name.replace(/\.mp3$/i, '');
    } else if (sourceMode === 'youtube') {
      setProgress(10, 'Mengunduh audio dari YouTube…');
      const r = await fetch(ytAudioUrl);
      if (!r.ok) throw new Error('Gagal mengunduh audio YouTube – coba muat ulang link.');
      blob = await r.blob();
      if (blob.size > MAX_FILE_BYTES) throw new Error(`File audio terlalu besar: ${formatBytes(blob.size)}. Maks 20 MB.`);
      baseName = sanitizeName(ytVideoTitle);
    } else {
      throw new Error('Tidak ada sumber audio yang dipilih.');
    }

    // Kirim ke backend FFmpeg
    setProgress(25, `Mengunggah & memproses (kecepatan ${speed}×, gain ${gainDb}dB)…`);
    const formData = new FormData();
    formData.append('file', blob, (baseName || 'audio') + '.mp3');
    formData.append('speed', String(speed));
    formData.append('gainDb', String(gainDb));
    formData.append('maxDur', String(maxDur));

    const res = await fetch('/api/convert', { method: 'POST', body: formData });

    setProgress(85, 'Menyelesaikan…');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Konversi gagal di server.');

    setProgress(100, 'Selesai!');

    dlOgg.href = data.ogg.url; dlOgg.download = (baseName || 'hasil') + '_converted.ogg';
    dlMp3.href = data.mp3.url; dlMp3.download = (baseName || 'hasil') + '_converted.mp3';

    const outDurSec = data.durations.output;
    const inDurSec  = data.durations.input;
    const outDurMin = Math.floor(outDurSec / 60);
    const outDurRemSec = Math.floor(outDurSec % 60);
    const durLabel = outDurMin > 0
      ? `${outDurMin} menit ${outDurRemSec} detik (${outDurSec.toFixed(1)}s)`
      : `${outDurSec.toFixed(1)} detik`;

    // Peringatan Roblox
    const robloxWarnings = [];
    if (data.ogg.size > 19.5 * 1024 * 1024) robloxWarnings.push('⚠ File OGG mendekati batas 20 MB Roblox');
    if (outDurSec > 420) robloxWarnings.push(`⚠ Durasi ${durLabel} melebihi 7 menit — Roblox mungkin menolak`);

    dlNote.innerHTML = `
      <strong>Durasi output: ${durLabel}</strong><br>
      Input: ${inDurSec.toFixed(1)}s → Output: ${outDurSec.toFixed(1)}s pada kecepatan ${speed}× (pitch tetap normal)<br>
      Amplifikasi: ${gainDb} dB · Durasi maks: ${maxDur}s<br>
      Codec: ${data.ogg.codec}
      ${robloxWarnings.length ? '<br><span style="color:#b45309">' + robloxWarnings.join('<br>') + '</span>' : ''}
    `;
    dlSize.textContent = `Ukuran — OGG: ${formatBytes(data.ogg.size)} · MP3: ${formatBytes(data.mp3.size)}`;
    downloadSection.classList.remove('hidden');
    progressWrap.classList.add('hidden');

  } catch (err) {
    progressWrap.classList.add('hidden');
    showStatus('Error: ' + err.message, true);
  } finally {
    convertBtn.disabled = false;
    readyToConvert();
  }
}
