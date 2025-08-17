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

if (process.env.YTDLP_COOKIES && !fs.existsSync(cookieFilePath)) {
  try {
    fs.writeFileSync(cookieFilePath, process.env.YTDLP_COOKIES, { mode: 0o600 });
  } catch (e) {}
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
  const ytCheck = fs.existsSync(localYtDlp) ? await checkCmdVersion(localYtDlp) : { ok: false, error: 'Binary not found' };
  const ffCheck = fs.existsSync(localFfmpeg) ? await checkCmdVersion(localFfmpeg, ['-version']) : { ok: false, error: 'Binary not found in bin; fallback may exist on PATH' };
}
init();

function tail(text = '', lines = 40) {
  if (!text) return '';
  const arr = text.split('\n');
  return arr.slice(-lines).join('\n');
}

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

    const child = spawn(exe, args, { env: { ...process.env }, ...opts });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', d => {
        const s = d.toString();
        stdout += s;
      });
    }
    if (child.stderr) {
      child.stderr.on('data', d => {
        const s = d.toString();
        stderr += s;
      });
    }

    child.on('error', err => reject({ code: -1, error: err.message, stdout, stderr }));
    child.on('close', code => {
      if (code === 0) return resolve({ code, stdout, stderr });
      return reject({ code, stdout, stderr });
    });
  });
}

async function progressiveYtdlp(actionArgs) {
  const attempts = [];

  attempts.push({ label: 'base', args: [...actionArgs] });
  attempts.push({ label: 'geo_allow', args: ['--geo-bypass', '--allow-unplayable-formats', ...actionArgs] });
  attempts.push({
    label: 'extractor_args_missing_pot',
    args: ['--extractor-args', 'youtube:formats=missing_pot,player_client=android', ...actionArgs]
  });
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
    }
  }
  const aggregated = errors.map(e => {
    const name = e.attempt || 'unknown';
    if (e.err) {
      const s = e.err.stderr || e.err.stdout || e.err.error || JSON.stringify(e.err);
      return `=== Attempt ${name} ===\n${tail(s,200)}\n`;
    } else {
      return `=== Attempt ${name} ===\n${tail(e.stderr || '',200)}\n`;
    }
  }).join('\n');
  const err = new Error('All yt-dlp attempts failed. See details.');
  err.details = aggregated;
  throw err;
}

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
    const { result } = await (async () => {
      const r = await progressiveYtdlp(baseArgs);
      return r;
    })();

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
      return res.status(500).json({ error: 'Failed to parse video info', details: tail((parseErr && parseErr.message) || '', 200) });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get video info', details: err.details || err.message || tail(String(err), 400) });
  }
});

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
      try { await downloadToFile(metadata.thumbnail, thumbPath); } catch (e) { thumbPath = null; }
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

app.post('/api/download', async (req, res) => {
  const { url, videoItag, audioItag } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  const id = uuidv4();
  const baseOutput = path.join(downloadsDir, id);
  const finalFilePath = `${baseOutput}.mp4`;

  let args = [
    '--no-warnings', '--ignore-errors', '--no-check-certificate', '--newline', '--progress',
    '--ffmpeg-location', binDir, ...getYoutubeHeaders(), '--no-playlist',
    '-o', `${baseOutput}.%(ext)s`, url
  ];
  if (videoItag && audioItag) args.push('-f', `${videoItag}+${audioItag}`);
  else if (videoItag) args.push('-f', `${videoItag}`);
  else args.push('-f', 'bestvideo+bestaudio');

  args.push('--merge-output-format', 'mp4', '--postprocessor-args', '-c:v copy -c:a aac -b:a 192k');
  args = args.filter(Boolean);

  const attemptLabels = [
    { label: 'base', args },
    { label: 'geo_allow', args: ['--geo-bypass','--allow-unplayable-formats', ...args] },
    { label: 'extractor_args_missing_pot', args: ['--extractor-args','youtube:formats=missing_pot,player_client=android', ...args] },
    { label: 'fallback_format', args: ['--geo-bypass','--allow-unplayable-formats', ...args, '-f', 'best'] }
  ];

  let lastErr = null;
  for (const at of attemptLabels) {
    try {
      const exe = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
      const spawnArgs = ['-v','--ignore-config', ...at.args];
      if (process.env.YTDLP_PROXY) spawnArgs.unshift('--proxy', process.env.YTDLP_PROXY);
      if (fs.existsSync(cookieFilePath)) spawnArgs.unshift('--cookies', cookieFilePath);

      const child = spawn(exe, spawnArgs, { stdio: ['ignore','pipe','pipe'], env: { ...process.env } });

      let stdout = '';
      let stderr = '';
      const progressRegex = /(\d+(?:\.\d+)?)%/;

      child.stdout.on('data', chunk => {
        const t = chunk.toString();
        stdout += t;
        const m = t.match(progressRegex);
        if (m) progressEmitter.emit('progress', { progress: parseFloat(m[1]) });
        if (t.includes('Destination:')) progressEmitter.emit('progress', { status: 'Downloading...' });
        if (t.includes('100%')) progressEmitter.emit('progress', { progress: 100, status: 'Finalizing...' });
      });

      child.stderr.on('data', chunk => {
        const t = chunk.toString();
        stderr += t;
        const m = t.match(progressRegex);
        if (m) progressEmitter.emit('progress', { progress: parseFloat(m[1]) });
      });

      const killTimeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 1000 * 60 * 15);

      const result = await new Promise((resolve, reject) => {
        child.on('error', e => { clearTimeout(killTimeout); reject(e); });
        child.on('close', code => { clearTimeout(killTimeout); resolve({ code, stdout, stderr }); });
      });

      if (result.code !== 0) {
        lastErr = result;
        const combined = (result.stderr || '') + (result.stdout || '');
        if (/playability status: UNPLAYABLE/i.test(combined) || /\bThis content isn’t available\b/i.test(combined) || /\bThis content isn't available\b/i.test(combined)) {
          continue;
        }
        continue;
      }

      if (!fs.existsSync(finalFilePath)) {
        lastErr = result;
        continue;
      }

      try {
        const info = await fetchVideoInfo(url);
        await embedMetadata(finalFilePath, { title: info.title, artist: info.uploader, thumbnail: info.thumbnail });
      } catch (metaErr) {}

      try {
        const files = fs.readdirSync(downloadsDir);
        files.forEach(f => { if (f.startsWith(id) && !f.endsWith('.mp4')) try { fs.unlinkSync(path.join(downloadsDir, f)); } catch(e){} });
      } catch (e) {}

      progressEmitter.emit('progress', { complete: true, file: `${id}.mp4` });
      return res.json({ success: true, file: `${id}.mp4` });
    } catch (err) {
      lastErr = err;
    }
  }

  const details = (lastErr && lastErr.stderr) ? tail(lastErr.stderr, 400) : (lastErr && lastErr.details) ? lastErr.details : JSON.stringify(lastErr);
  return res.status(500).json({ error: 'Download failed after fallback attempts', details });
});

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

function formatDuration(seconds) { const mins = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); return `${mins}:${secs.toString().padStart(2,'0')}`; }
function formatViews(views) { if (!views) return '0 views'; const count = parseInt(views); if (isNaN(count)) return '0 views'; if (count > 1000000) return `${(count/1000000).toFixed(1)}M views`; if (count > 1000) return `${(count/1000).toFixed(1)}K views`; return `${count} views`; }
function formatDate(dateStr) { if (!dateStr) return 'Unknown'; try { if (/^\\d{8}$/.test(dateStr)) { const y=dateStr.slice(0,4), m=dateStr.slice(4,6), d=dateStr.slice(6,8); return new Date(`${y}-${m}-${d}`).toLocaleDateString(); } return new Date(dateStr).toLocaleDateString(); } catch (e) { return 'Unknown'; } }

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(downloadsDir, { setHeaders: (res, filePath) => { res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`); } }));

app.get('/api/probe', (req, res) => {
  res.json({ yt_dlp: { path: localYtDlp, exists: fs.existsSync(localYtDlp) }, ffmpeg: { path: localFfmpeg, exists: fs.existsSync(localFfmpeg) }, cookie: { path: cookieFilePath, exists: fs.existsSync(cookieFilePath) } });
});

process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT} (port ${PORT})`));
