/* =====================================================
   server.js — AudioShift Backend (Node.js + FFmpeg)
   - Serve frontend statis (public/)
   - API konversi audio (/api/convert)
   - Serve hasil konversi (/outputs)
===================================================== */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const convertRoute = require('./routes/convert');

const app  = express();
const PORT = process.env.PORT || 3000;

const OUTPUT_DIR = path.join(__dirname, 'outputs');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
for (const dir of [OUTPUT_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json());

// Frontend statis
app.use(express.static(path.join(__dirname, 'public')));

// File hasil konversi (didownload via <a download>)
app.use('/outputs', express.static(OUTPUT_DIR));

// API
app.use('/api', convertRoute);

// Health check (berguna untuk deploy: Render/Railway/dll.)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'AudioShift server berjalan.' });
});

// Fallback ke index.html untuk SPA-style routing (opsional)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/outputs')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler (multer & lainnya)
app.use((err, req, res, next) => {
  console.error('[server] error:', err.message);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`AudioShift server berjalan di http://localhost:${PORT}`);
});
