// server.js — updated with safer format selection and debug list-formats on failure
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const util = require('util');
const axios = require('axios');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);
const promisifiedExec = util.promisify(require('child_process').exec);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const downloadsDir = path.join(__dirname, 'downloads');
const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

const progressEmitter = new EventEmitter();

const localYtDlp = path.join(binDir, 'yt-dlp');
const localFfmpeg = path.join(binDir, 'ffmpeg');
const cookieFilePath = path.join(binDir, 'cookies.txt');

// If YTDLP_COOKIES env provided (string content), write to cookie file (secure)
if (process.env.YTDLP_COOKIES && !fs.existsSync(cookieFilePath)) {
  try {
    fs.writeFileSync(cookieFilePath, process.env.YTDLP_COOKIES, { mode: 0o600 });
    console.log('Wrote cookies file to', cookieFilePath);
  } catch (e) {
    console.warn('Failed to write cookies file from YTDLP_COOKIES env:', e.message);
  }
}

function getYoutubeHeaders() {
  return [
    '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    '--add-header', 'Referer: https://www.youtube.com/',
    '--add-header', 'Accept: */*',
    '--add-header', 'Accept-Language: en-US,en;q=0.9',
    '--add-header', 'Origin: https://www.youtube.com'
  ];
}

async function checkCmdVersion(cmd, args = ['--version']) {
  try {
    const { stdout, stderr } = await promisifiedExec(`${cmd} ${args.join(' ')}`);
    return { ok: true, version: (stderr || stdout).split('\n')[0] || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function init() {
  console.log('Using yt-dlp:', fs.existsSync(localYtDlp) ? localYtDlp : (process.platform === 'linux' ? 'yt-dlp' : 'yt-dlp (PATH)'));
  console.log('Using ffmpeg:', fs.existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg (PATH)');
  const ytCheck = fs.existsSync(localYtDlp) ? await checkCmdVersion(localYtDlp) : { ok: false, error: 'Binary not found' };
  const ffCheck = fs.existsSync(localFfmpeg) ? await checkCmdVersion(localFfmpeg, ['-version']) : { ok: false, error: 'Binary not found in bin; fallback may exist on PATH' };
  console.log('yt-dlp:', ytCheck);
  console.log('ffmpeg:', ffCheck);
}
init();

function tail(text = '', lines = 40) {
  if (!text) return '';
  const arr = text.split('\n');
  return arr.slice(-lines).join('\n');
}

// spawn helper with verbose and cookie/proxy support
function runYtDlpWithArgs(extraArgs = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const exe = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
    const args = ['-v', '--ignore-config', ...extraArgs];
    if (process.env.YTDLP_PROXY) {
      args.unshift('--proxy', process.env.YTDLP_PROXY);
    }
    if (fs.existsSync(cookieFilePath)) {
      args.unshift('--cookies', cookieFilePath);
    }

    console.log('Spawning yt-dlp:', exe, args.join(' '));
    const child = spawn(exe, args, { env: { ...process.env }, ...opts });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', d => {
        const s = d.toString();
        stdout += s;
        process.stdout.write('[yt-dlp stdout] ' + s);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', d => {
        const s = d.toString();
        stderr += s;
        process.stderr.write('[yt-dlp stderr] ' + s);
      });
    }

    child.on('error', err => reject({ code: -1, error: err.message, stdout, stderr }));
    child.on('close', code => {
      if (code === 0) return resolve({ code, stdout, stderr });
      return reject({ code, stdout, stderr });
    });
  });
}

// progressive fallback function to get JSON info or run download
async function progressiveYtdlp(actionArgs) {
  // actionArgs: array of args to run for the basic attempt (not including -v/--ignore-config)
  // return { ok: true, attempt, result } or throw aggregated error with details
  const attempts = [];

  // Attempt 1: base
  attempts.push({ label: 'base', args: [...actionArgs] });

  // Attempt 2: geo-bypass + allow-unplayable-formats
  attempts.push({ label: 'geo_allow', args: ['--geo-bypass', '--allow-unplayable-formats', ...actionArgs] });

  // Attempt 3: extractor-args to try missing_pot / alternative player client (may help)
  attempts.push({
    label: 'extractor_args_missing_pot',
    args: ['--extractor-args', 'youtube:formats=missing_pot,player_client=android', ...actionArgs]
  });

  // Attempt 4: final with allow-unplayable-formats & cookies
  attempts.push({ label: 'final_allow_with_cookies', args: ['--allow-unplayable-formats', '--geo-bypass', ...actionArgs] });

  const errors = [];
  for (const at of attempts) {
    try {
      const result = await runYtDlpWithArgs(at.args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const combined = (result.stdout || '') + (result.stderr || '');
      if (/playability status: UNPLAYABLE/i.test(combined) || /\bThis content isn’t available\b/i.test(combined) || /\bThis content isn't available\b/i.test(combined)) {
        errors.push({ attempt: at.label, stderr: tail(result.stderr, 200), stdout: tail(result.stdout, 50) });
        continue;
      }
      return { ok: true, attempt: at.label, result };
    } catch (err) {
      errors.push({ attempt: at.label, err });
      // continue trying
    }
  }
  // No attempts succeeded — throw aggregated error
  const aggregated = errors.map(e => {
    const name = e.attempt || 'unknown';
    if (e.err) {
      const s = e.err.stderr || e.err.stdout || e.err.error || JSON.stringify(e.err);
      return `=== Attempt ${name} ===\n${tail(s, 200)}\n`;
    } else {
      return `=== Attempt ${name} ===\n${tail(e.stderr || '', 200)}\n`;
    }
  }).join('\n');
  const err = new Error('All yt-dlp attempts failed. See details.');
  err.details = aggregated;
  throw err;
}

// ---------- /api/info endpoint (uses progressiveYtdlp) ----------
app.post('/api/info', async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const baseArgs = [
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--no-check-certificate',
    ...getYoutubeHeaders(),
    url
  ];

  try {
    const r = await progressiveYtdlp(baseArgs);
    const result = r.result;

    try {
      const firstBrace = result.stdout.indexOf('{');
      const jsonText = firstBrace >= 0 ? result.stdout.slice(firstBrace) : result.stdout;
      const info = JSON.parse(jsonText);

      const allFormats = info.formats || [];
      const videoFormats = allFormats.filter(f => f.vcodec && f.vcodec !== 'none').map(f => {
        const sizeMB = f.filesize ? Math.round(f.filesize / (1024 * 1024)) : (f.filesize_approx ? Math.round(f.filesize_approx / (1024 * 1024)) : 0);
        return { resolution: f.format_note || (f.height ? `${f.height}p` : 'Unknown'), codec: [f.vcodec, f.acodec].filter(Boolean).join('+'), container: f.ext, sizeMB, bitrate: f.tbr || 0, itag: f.format_id, hasAudio: f.acodec !== 'none' };
      }).sort((a,b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));

      const audioFormats = allFormats.filter(f => f.acodec && f.acodec !== 'none' && (!f.height || f.vcodec === 'none')).map(f => ({ itag: f.format_id, bitrate: f.tbr || 0, container: f.ext })).sort((a,b) => b.bitrate - a.bitrate);

      let date = 'Unknown';
      if (info.upload_date) date = formatDate(info.upload_date);
      else if (info.release_timestamp) date = new Date(info.release_timestamp * 1000).toLocaleDateString();

      return res.json({
        title: info.title || 'Untitled Video',
        thumbnail: info.thumbnail || '',
        duration: formatDuration(info.duration || 0),
        views: formatViews(info.view_count || 0),
        date,
        formats: videoFormats,
        audioFormats,
        uploader: info.uploader || 'Unknown'
      });
    } catch (parseErr) {
      console.error('Failed to parse yt-dlp JSON:', parseErr);
      return res.status(500).json({ error: 'Failed to parse video info', details: tail((parseErr && parseErr.message) || '', 200) });
    }
  } catch (err) {
    console.error('api/info error aggregated:', err);
    return res.status(500).json({ error: 'Failed to get video info', details: err.details || err.message || tail(String(err), 400) });
  }
});

// ---------- SSE progress endpoint ----------
app.get('/api/download/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const progressHandler = data => {
    try { res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };
  progressEmitter.on('progress', progressHandler);
  req.on('close', () => {
    progressEmitter.off('progress', progressHandler);
    try { res.end(); } catch (e) {}
  });
});

// embedMetadata helper (unchanged, uses ffmpeg)
const embedMetadata = async (filePath, metadata) => {
  const tempPath = path.join(downloadsDir, `meta_temp_${path.basename(filePath)}`);
  let thumbPath = null;
  async function downloadToFile(url, dest) {
    const response = await axios.get(url, { responseType: 'stream', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com/' } });
    await pipeline(response.data, fs.createWriteStream(dest));
  }
  try {
    if (metadata && metadata.thumbnail && /^https?:\/\//i.test(metadata.thumbnail)) {
      thumbPath = path.join(downloadsDir, `thumb_${uuidv4()}.jpg`);
      try { await downloadToFile(metadata.thumbnail, thumbPath); } catch (e) { console.warn('thumb download failed', e.message); thumbPath = null; }
    } else if (metadata && metadata.thumbnail && fs.existsSync(metadata.thumbnail)) thumbPath = metadata.thumbnail;

    let args;
    if (thumbPath) {
      args = ['-y', '-i', filePath, '-i', thumbPath, '-map', '0', '-map', '1', '-c', 'copy', '-metadata', `title=${metadata.title||''}`, '-metadata', `artist=${metadata.artist||''}`, '-metadata', `comment=Downloaded with Online Downloader`, '-disposition:v:1', 'attached_pic', tempPath];
    } else {
      args = ['-y', '-i', filePath, '-c', 'copy', '-metadata', `title=${metadata.title||''}`, '-metadata', `artist=${metadata.artist||''}`, '-metadata', `comment=Downloaded with Online Downloader`, tempPath];
    }

    await new Promise((resolve, reject) => {
      const ffExe = fs.existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg';
      const ff = spawn(ffExe, args, { env: { ...process.env } });
      let stderr = '';
      ff.stderr.on('data', d => stderr += d.toString());
      ff.on('error', e => reject(e));
      ff.on('close', code => {
        if (code === 0) {
          try { fs.renameSync(tempPath, filePath); if (thumbPath && thumbPath.includes('thumb_') && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch (e) {}
          resolve();
        } else reject(new Error(`FFmpeg failed code ${code}. stderr: ${tail(stderr,200)}`));
      });
    });
  } catch (err) { throw err; }
};

// ---------- /api/download endpoint (uses progressive fallback for downloads too) ----------
app.post('/api/download', async (req, res) => {
  const { url, videoItag, audioItag } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const id = uuidv4();
  const baseOutput = path.join(downloadsDir, id);
  const finalFilePath = `${baseOutput}.mp4`;

  // --------- SAFER FORMAT SELECTION ---------
  // Pre-check info and choose safest format selection strategy
  let chosenFormat = null;
  let infoObj = null;
  try {
    const dumpArgs = ['--dump-json', '--no-warnings', '--ignore-errors', '--no-check-certificate', ...getYoutubeHeaders(), url];
    const infoRes = await progressiveYtdlp(dumpArgs);
    const out = infoRes.result.stdout || '';
    const firstBrace = out.indexOf('{');
    const jsonText = firstBrace >= 0 ? out.slice(firstBrace) : out;
    infoObj = JSON.parse(jsonText);
  } catch (e) {
    console.warn('Warning: could not fetch full info for format selection, falling back to defaults', e && e.stderr ? tail(e.stderr,200) : (e && e.message) ? e.message : e);
  }

  // safe default: prefer mp4 container if available (avoids webm/opus issues)
  const preferredFormatFallback = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

  // Validate requested itags when provided
  if (videoItag && audioItag) {
    if (infoObj && infoObj.formats) {
      const vidExists = infoObj.formats.some(f => String(f.format_id) === String(videoItag));
      const audExists = infoObj.formats.some(f => String(f.format_id) === String(audioItag));
      if (vidExists && audExists) {
        chosenFormat = `${videoItag}+${audioItag}`;
      } else {
        chosenFormat = preferredFormatFallback;
      }
    } else {
      chosenFormat = `${videoItag}+${audioItag}`;
    }
  } else if (videoItag && !audioItag) {
    if (infoObj && infoObj.formats) {
      const vidFmt = infoObj.formats.find(f => String(f.format_id) === String(videoItag));
      if (vidFmt) {
        if (vidFmt.acodec && vidFmt.acodec !== 'none') {
          chosenFormat = `${videoItag}`;
        } else {
          const sameExtAudio = infoObj.formats.find(f => f.acodec && f.acodec !== 'none' && f.ext === vidFmt.ext);
          const anyAudio = infoObj.formats.find(f => f.acodec && f.acodec !== 'none');
          const audioCandidate = sameExtAudio || anyAudio;
          if (audioCandidate) chosenFormat = `${videoItag}+${audioCandidate.format_id}`;
          else chosenFormat = `${videoItag}`;
        }
      } else {
        chosenFormat = preferredFormatFallback;
      }
    } else {
      chosenFormat = preferredFormatFallback;
    }
  } else {
    chosenFormat = preferredFormatFallback;
  }

  // Build base yt-dlp args (safer defaults)
  let args = [
    '--no-warnings', '--ignore-errors', '--no-check-certificate', '--newline', '--progress',
    '--ffmpeg-location', binDir, ...getYoutubeHeaders(), '--no-playlist',
    '-o', `${baseOutput}.%(ext)s`, url
  ];

  if (chosenFormat) args.push('-f', chosenFormat);

  // Ensure mp4 output reliably (recode as last resort)
  args.push('--merge-output-format', 'mp4');
  // recode-video is heavier but helps produce mp4-compatible file when inputs are webm
  args.push('--recode-video', 'mp4');
  args.push('--postprocessor-args', '-c:a aac -b:a 192k');
  args = args.filter(Boolean);

  // We'll attempt with fallbacks manually to capture progress events for the successful attempt
  const attemptLabels = [
    { label: 'base', args },
    { label: 'geo_allow', args: ['--geo-bypass','--allow-unplayable-formats', ...args] },
    { label: 'extractor_args_missing_pot', args: ['--extractor-args','youtube:formats=missing_pot,player_client=android', ...args] },
    { label: 'final_allow_with_cookies', args: ['--allow-unplayable-formats','--geo-bypass', ...args] }
  ];

  let lastErr = null;
  for (const at of attemptLabels) {
    try {
      const exe = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
      const spawnArgs = ['-v','--ignore-config', ...at.args];
      if (process.env.YTDLP_PROXY) spawnArgs.unshift('--proxy', process.env.YTDLP_PROXY);
      if (fs.existsSync(cookieFilePath)) spawnArgs.unshift('--cookies', cookieFilePath);

      console.log('Spawning yt-dlp for download attempt', at.label, exe, spawnArgs.slice(0, 12).join(' ') + ' ...');
      const child = spawn(exe, spawnArgs, { stdio: ['ignore','pipe','pipe'], env: { ...process.env } });

      let stdout = '';
      let stderr = '';
      const progressRegex = /(\d+(?:\.\d+)?)%/;

      child.stdout.on('data', chunk => {
        const t = chunk.toString();
        stdout += t;
        process.stdout.write('[yt-dlp stdout] ' + t);
        const m = t.match(progressRegex);
        if (m) progressEmitter.emit('progress', { progress: parseFloat(m[1]) });
        if (t.includes('Destination:')) progressEmitter.emit('progress', { status: 'Downloading...' });
        if (t.includes('100%')) progressEmitter.emit('progress', { progress: 100, status: 'Finalizing...' });
      });

      child.stderr.on('data', chunk => {
        const t = chunk.toString();
        stderr += t;
        process.stderr.write('[yt-dlp stderr] ' + t);
        const m = t.match(progressRegex);
        if (m) progressEmitter.emit('progress', { progress: parseFloat(m[1]) });
      });

      const killTimeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 1000 * 60 * 15);

      // Wait for close
      const result = await new Promise((resolve, reject) => {
        child.on('error', e => { clearTimeout(killTimeout); reject(e); });
        child.on('close', code => { clearTimeout(killTimeout); resolve({ code, stdout, stderr }); });
      });

      if (result.code !== 0) {
        lastErr = result;
        console.warn(`Attempt ${at.label} exited ${result.code}`);
        const combined = (result.stderr || '') + (result.stdout || '');
        if (/playability status: UNPLAYABLE/i.test(combined) || /\bThis content isn’t available\b/i.test(combined) || /\bThis content isn't available\b/i.test(combined)) {
          continue;
        }
        continue;
      }

      // success — check final file exists
      if (!fs.existsSync(finalFilePath)) {
        lastErr = result;
        continue;
      }

      // success path
      try {
        const info = await fetchVideoInfo(url);
        await embedMetadata(finalFilePath, { title: info.title, artist: info.uploader, thumbnail: info.thumbnail });
      } catch (metaErr) {
        console.warn('Metadata embed failed:', metaErr && metaErr.message ? metaErr.message : metaErr);
      }

      // cleanup other temp files
      try {
        const files = fs.readdirSync(downloadsDir);
        files.forEach(f => { if (f.startsWith(id) && !f.endsWith('.mp4')) try { fs.unlinkSync(path.join(downloadsDir, f)); } catch(e){} });
      } catch (e) {}

      progressEmitter.emit('progress', { complete: true, file: `${id}.mp4` });
      return res.json({ success: true, file: `${id}.mp4` });
    } catch (err) {
      lastErr = err;
      console.error(`Download attempt ${at.label} error:`, (err && err.stderr) ? tail(err.stderr,200) : (err && err.message) ? err.message : err);
      // continue to next attempt
    }
  }

  // all attempts failed — attempt debug list-formats to aid debugging
  try {
    const listRes = await runYtDlpWithArgs(['--list-formats', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    const formatsDump = tail(listRes.stdout || listRes.stderr || '', 1200);
    const details = (lastErr && lastErr.stderr) ? tail(lastErr.stderr, 400) : (lastErr && lastErr.details) ? lastErr.details : JSON.stringify(lastErr);
    return res.status(500).json({ error: 'Download failed after fallback attempts', details, formats: formatsDump });
  } catch (listErr) {
    const details = (lastErr && lastErr.stderr) ? tail(lastErr.stderr, 400) : (lastErr && lastErr.details) ? lastErr.details : JSON.stringify(lastErr);
    const listDetails = (listErr && listErr.stderr) ? tail(listErr.stderr, 400) : (listErr && listErr.message) ? listErr.message : JSON.stringify(listErr);
    return res.status(500).json({ error: 'Download failed after fallback attempts', details, list_error: listDetails });
  }
});

// fetchVideoInfo helper (uses progressive fallback)
async function fetchVideoInfo(url) {
  const baseArgs = ['--dump-json','--no-warnings','--ignore-errors','--no-check-certificate', ...getYoutubeHeaders(), url];
  try {
    const r = await progressiveYtdlp(baseArgs);
    const firstBrace = r.result.stdout.indexOf('{');
    const jsonText = firstBrace >= 0 ? r.result.stdout.slice(firstBrace) : r.result.stdout;
    const info = JSON.parse(jsonText);
    return { title: info.title || 'Untitled Video', uploader: info.uploader || 'Unknown', thumbnail: info.thumbnail || '' };
  } catch (err) {
    throw err;
  }
}

// helpers formatters
function formatDuration(seconds) { const mins = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); return `${mins}:${secs.toString().padStart(2,'0')}`; }
function formatViews(views) { if (!views) return '0 views'; const count = parseInt(views); if (isNaN(count)) return '0 views'; if (count > 1000000) return `${(count/1000000).toFixed(1)}M views`; if (count > 1000) return `${(count/1000).toFixed(1)}K views`; return `${count} views`; }
function formatDate(dateStr) { if (!dateStr) return 'Unknown'; try { if (/^\\d{8}$/.test(dateStr)) { const y=dateStr.slice(0,4), m=dateStr.slice(4,6), d=dateStr.slice(6,8); return new Date(`${y}-${m}-${d}`).toLocaleDateString(); } return new Date(dateStr).toLocaleDateString(); } catch (e) { return 'Unknown'; } }

// static serving & probe
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(downloadsDir, { setHeaders: (res, filePath) => { res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`); } }));

app.get('/api/probe', (req, res) => {
  res.json({ yt_dlp: { path: localYtDlp, exists: fs.existsSync(localYtDlp) }, ffmpeg: { path: localFfmpeg, exists: fs.existsSync(localFfmpeg) }, cookie: { path: cookieFilePath, exists: fs.existsSync(cookieFilePath) } });
});

process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT} (port ${PORT})`));


