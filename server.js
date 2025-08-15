// server.js (updated)
// Combines robust yt-dlp usage, verbose logging for Render logs (no shell needed),
// cookie/env handling, and your existing download/info/progress flow.

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

// Create directories
const downloadsDir = path.join(__dirname, 'downloads');
const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

const progressEmitter = new EventEmitter();

// Local binary paths (prefer bundled ./bin/ directory)
const ffmpegCommand = fs.existsSync(path.join(binDir, 'ffmpeg')) ? path.join(binDir, 'ffmpeg') : 'ffmpeg';
const ytDlpCommand = fs.existsSync(path.join(binDir, 'yt-dlp')) ? path.join(binDir, 'yt-dlp') : 'yt-dlp';
const cookieFilePath = path.join(binDir, 'cookies.txt');

// If user provided cookie content as an env var (RENDER secret), write to file at startup
if (process.env.YTDLP_COOKIES && !fs.existsSync(cookieFilePath)) {
    try {
        fs.writeFileSync(cookieFilePath, process.env.YTDLP_COOKIES, { mode: 0o600 });
        console.log('Wrote cookies file to', cookieFilePath);
    } catch (e) {
        console.warn('Failed to write cookies file from YTDLP_COOKIES env:', e.message);
    }
}

// Enhanced YouTube headers
function getYoutubeHeaders() {
    return [
        '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        '--add-header', 'Referer: https://www.youtube.com/',
        '--add-header', 'Accept: */*',
        '--add-header', 'Accept-Language: en-US,en;q=0.9',
        '--add-header', 'Origin: https://www.youtube.com'
    ];
}

// Utility: run shell command to check versions (used on init)
async function checkCmdVersion(cmd, args = ['--version']) {
    try {
        const { stdout, stderr } = await promisifiedExec(`${cmd} ${args.join(' ')}`);
        if (stderr && stderr.trim()) return { ok: true, version: stderr.split('\n')[0] || '' };
        return { ok: true, version: stdout.split('\n')[0] || '' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Init: print versions / existence
async function init() {
    console.log('Using yt-dlp:', ytDlpCommand, 'exists=', fs.existsSync(ytDlpCommand));
    console.log('Using ffmpeg:', ffmpegCommand, 'exists=', fs.existsSync(ffmpegCommand));

    const ytCheck = fs.existsSync(ytDlpCommand) ? await checkCmdVersion(ytDlpCommand) : { ok: false, error: 'Binary not found' };
    const ffCheck = fs.existsSync(path.join(binDir, 'ffmpeg')) ? await checkCmdVersion(ffmpegCommand, ['-version']) : { ok: false, error: 'Binary not found in bin; fallback may exist on PATH' };

    console.log('yt-dlp:', ytCheck);
    console.log('ffmpeg:', ffCheck);

    if (!ytCheck.ok) console.warn('⚠️ yt-dlp not found or not runnable by this Node process. Install or ensure bin/yt-dlp exists.');
    if (!ffCheck.ok) console.warn('⚠️ ffmpeg not found in bin (or not runnable). Some merges/metadata embedding may fail.');
}
init();

// Helper: tail last N lines of string
function tail(text = '', lines = 40) {
    if (!text) return '';
    const arr = text.split('\n');
    return arr.slice(-lines).join('\n');
}

// Spawn yt-dlp with verbose logging and capture outputs
function spawnYtdlp(args = [], opts = {}) {
    return new Promise((resolve, reject) => {
        const exe = fs.existsSync(ytDlpCommand) ? ytDlpCommand : 'yt-dlp';
        // Add verbose & ignore config to make logs deterministic and helpful
        const fullArgs = ['-v', '--ignore-config', ...args];
        if (process.env.YTDLP_PROXY) {
            fullArgs.unshift('--proxy', process.env.YTDLP_PROXY);
        }
        // If cookie file exists, add it automatically
        if (fs.existsSync(cookieFilePath)) {
            fullArgs.unshift('--cookies', cookieFilePath);
        }

        console.log('Spawning yt-dlp:', exe, fullArgs.join(' '));
        const child = spawn(exe, fullArgs, { env: { ...process.env }, ...opts });

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

// ---------- /api/info endpoint ----------
app.post('/api/info', async (req, res) => {
    const videoUrl = req.body.url;
    if (!videoUrl) return res.status(400).json({ error: 'Missing URL' });

    try {
        const args = [
            '--dump-json',
            '--no-warnings',
            '--ignore-errors',
            '--no-check-certificate',
            ...getYoutubeHeaders(),
            videoUrl
        ];

        // Run and capture
        const { stdout, stderr } = await spawnYtdlp(args, { stdio: ['ignore', 'pipe', 'pipe'] });

        // Parse JSON (some extractors may print multiple JSON objects; take first valid parse)
        let info = null;
        try {
            // sometimes yt-dlp prints logs before JSON; find first "{" index
            const firstBrace = stdout.indexOf('{');
            const jsonText = firstBrace >= 0 ? stdout.slice(firstBrace) : stdout;
            info = JSON.parse(jsonText);
        } catch (parseErr) {
            console.error('Failed to parse yt-dlp output as JSON:', parseErr.message);
            console.error('Yt-dlp stderr tail:\n', tail(stderr, 80));
            return res.status(500).json({ error: 'Failed to parse video info', details: tail(stderr, 80) });
        }

        // Build format lists
        const allFormats = info.formats || [];
        const videoFormats = allFormats
            .filter(f => f.vcodec && f.vcodec !== 'none')
            .map(f => {
                const sizeMB = f.filesize ? Math.round(f.filesize / (1024 * 1024)) : (f.filesize_approx ? Math.round(f.filesize_approx / (1024 * 1024)) : 0);
                return {
                    resolution: f.format_note || (f.height ? `${f.height}p` : 'Unknown'),
                    codec: [f.vcodec, f.acodec].filter(Boolean).join('+'),
                    container: f.ext,
                    sizeMB,
                    bitrate: f.tbr || 0,
                    itag: f.format_id,
                    hasAudio: f.acodec !== 'none'
                };
            }).sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));

        const audioFormats = allFormats
            .filter(f => f.acodec && f.acodec !== 'none' && (!f.height || f.vcodec === 'none'))
            .map(f => ({ itag: f.format_id, bitrate: f.tbr || 0, container: f.ext }))
            .sort((a, b) => b.bitrate - a.bitrate);

        let date = 'Unknown';
        if (info.upload_date) {
            date = formatDate(info.upload_date);
        } else if (info.release_timestamp) {
            date = new Date(info.release_timestamp * 1000).toLocaleDateString();
        }

        res.json({
            title: info.title || 'Untitled Video',
            thumbnail: info.thumbnail || '',
            duration: formatDuration(info.duration || 0),
            views: formatViews(info.view_count || 0),
            date,
            formats: videoFormats,
            audioFormats,
            uploader: info.uploader || 'Unknown'
        });
    } catch (err) {
        console.error('api/info error:', err);
        const details = err.stderr ? tail(err.stderr, 120) : (err.error || err.message || 'Unknown');
        res.status(500).json({ error: 'Failed to get video info', details });
    }
});

// ---------- SSE progress endpoint ----------
app.get('/api/download/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    const progressHandler = data => {
        try {
            res.write(`event: progress\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) { /* ignore write errors */ }
    };

    progressEmitter.on('progress', progressHandler);

    req.on('close', () => {
        progressEmitter.off('progress', progressHandler);
        try { res.end(); } catch (e) { /* ignore */ }
    });
});

// ---------- embedMetadata helper ----------
const embedMetadata = async (filePath, metadata) => {
    const tempPath = path.join(downloadsDir, `meta_temp_${path.basename(filePath)}`);
    let thumbPath = null;

    async function downloadToFile(url, dest) {
        const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://www.youtube.com/',
                'Accept': '*/*'
            }
        });
        await pipeline(response.data, fs.createWriteStream(dest));
    }

    try {
        if (metadata && metadata.thumbnail && /^https?:\/\//i.test(metadata.thumbnail)) {
            thumbPath = path.join(downloadsDir, `thumb_${uuidv4()}.jpg`);
            try {
                await downloadToFile(metadata.thumbnail, thumbPath);
            } catch (dlErr) {
                console.warn('Thumbnail download failed, continuing without cover:', dlErr.message);
                thumbPath = null;
            }
        } else if (metadata && metadata.thumbnail && fs.existsSync(metadata.thumbnail)) {
            thumbPath = metadata.thumbnail;
        }

        let args;
        if (thumbPath) {
            // attach cover art
            args = [
                '-y',
                '-i', filePath,
                '-i', thumbPath,
                '-map', '0',
                '-map', '1',
                '-c', 'copy',
                '-metadata', `title=${metadata.title || ''}`,
                '-metadata', `artist=${metadata.artist || ''}`,
                '-metadata', `comment=Downloaded with Online Downloader`,
                '-disposition:v:1', 'attached_pic',
                tempPath
            ];
        } else {
            args = [
                '-y',
                '-i', filePath,
                '-c', 'copy',
                '-metadata', `title=${metadata.title || ''}`,
                '-metadata', `artist=${metadata.artist || ''}`,
                '-metadata', `comment=Downloaded with Online Downloader`,
                tempPath
            ];
        }

        // run ffmpeg
        await new Promise((resolve, reject) => {
            const ff = spawn(ffmpegCommand, args, { env: { ...process.env } });
            let stderr = '';
            ff.stderr.on('data', d => stderr += d.toString());
            ff.on('error', err => reject(err));
            ff.on('close', code => {
                if (code === 0) {
                    try {
                        fs.renameSync(tempPath, filePath);
                        if (thumbPath && thumbPath.includes('thumb_') && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
                    } catch (e) {
                        console.warn('embedMetadata cleanup error:', e.message);
                    }
                    resolve();
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}. Stderr: ${tail(stderr, 200)}`));
                }
            });
        });
    } catch (err) {
        throw err;
    }
};

// ---------- /api/download endpoint ----------
app.post('/api/download', async (req, res) => {
    const { url, videoItag, audioItag } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    const id = uuidv4();
    const baseOutput = path.join(downloadsDir, id);
    const finalFilePath = `${baseOutput}.mp4`;

    // Build yt-dlp args
    let args = [
        '--no-warnings',
        '--ignore-errors',
        '--no-check-certificate',
        '--newline',
        '--progress',
        '--ffmpeg-location', binDir,
        ...getYoutubeHeaders(),
        '--no-playlist',
        '-o', `${baseOutput}.%(ext)s`,
        url
    ];

    if (videoItag && audioItag) args.push('-f', `${videoItag}+${audioItag}`);
    else if (videoItag) args.push('-f', `${videoItag}`);
    else args.push('-f', 'bestvideo+bestaudio');

    args.push('--merge-output-format', 'mp4', '--postprocessor-args', '-c:v copy -c:a aac -b:a 192k');

    // Filter undefined
    const filteredArgs = args.filter(a => a !== undefined && a !== null && String(a).trim() !== '');

    console.log('Starting download', { id, args: filteredArgs.slice(0, 8).concat(['...']) });

    // retry logic
    const maxRetries = 2;
    let attempt = 0;
    let ok = false;
    let lastError = null;

    const attemptDownload = () => new Promise((resolve, reject) => {
        attempt++;
        const exe = fs.existsSync(ytDlpCommand) ? ytDlpCommand : 'yt-dlp';
        const child = spawn(exe, ['-v', '--ignore-config', ...filteredArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });

        let stdout = '';
        let stderr = '';
        const progressRegex = /(\d+(?:\.\d+)?)%/;

        child.stdout.on('data', chunk => {
            const text = chunk.toString();
            stdout += text;
            process.stdout.write('[yt-dlp stdout] ' + text);
            const m = text.match(progressRegex);
            if (m) progressEmitter.emit('progress', { progress: parseFloat(m[1]) });
            if (text.includes('Destination:')) progressEmitter.emit('progress', { status: 'Downloading...' });
            if (text.includes('100%')) progressEmitter.emit('progress', { progress: 100, status: 'Finalizing...' });
        });

        child.stderr.on('data', chunk => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write('[yt-dlp stderr] ' + text);
            const m = text.match(progressRegex);
            if (m) progressEmitter.emit('progress', { progress: parseFloat(m[1]) });
        });

        const killTimeout = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
            progressEmitter.emit('progress', { error: 'Download timed out' });
            reject(new Error('Download timed out'));
        }, 1000 * 60 * 15); // 15 minutes

        child.on('error', err => {
            clearTimeout(killTimeout);
            reject(err);
        });

        child.on('close', code => {
            clearTimeout(killTimeout);
            if (code !== 0) {
                lastError = { code, stdout, stderr };
                progressEmitter.emit('progress', { error: 'Download failed', details: `Attempt ${attempt} exit ${code}` });
                return reject(new Error(`yt-dlp exit ${code}`));
            }

            // Find the created file (could be .mp4 or other ext before merge)
            // We expect merged mp4 exists
            if (!fs.existsSync(finalFilePath)) {
                lastError = { code: 0, stdout, stderr };
                progressEmitter.emit('progress', { error: 'File not created', details: 'Expected final mp4 not found' });
                return reject(new Error('File not created'));
            }

            resolve({ stdout, stderr });
        });
    });

    while (attempt <= maxRetries && !ok) {
        try {
            const result = await attemptDownload();
            ok = true;
            console.log('Download succeeded for', id);
        } catch (err) {
            console.error(`Attempt ${attempt} failed:`, err.message);
            if (attempt >= maxRetries) {
                const details = lastError && lastError.stderr ? tail(lastError.stderr, 200) : (err.stderr ? tail(err.stderr, 200) : err.message);
                return res.status(500).json({ error: 'Download failed after retries', details });
            }
            // small backoff
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // Try to embed metadata
    try {
        const videoInfo = await fetchVideoInfo(url);
        await embedMetadata(finalFilePath, {
            title: videoInfo.title,
            artist: videoInfo.uploader,
            thumbnail: videoInfo.thumbnail
        });
    } catch (metaErr) {
        console.warn('Metadata embedding failed:', metaErr.message || metaErr);
    }

    // clean up auxiliary files that start with id but are not .mp4
    try {
        const files = fs.readdirSync(downloadsDir);
        files.forEach(file => {
            if (file.startsWith(id) && !file.endsWith('.mp4')) {
                try { fs.unlinkSync(path.join(downloadsDir, file)); } catch (e) { /* ignore */ }
            }
        });
    } catch (e) {
        console.warn('Cleanup error:', e.message);
    }

    progressEmitter.emit('progress', { complete: true, file: `${id}.mp4` });
    res.json({ success: true, file: `${id}.mp4` });
});

// ---------- fetchVideoInfo helper ----------
async function fetchVideoInfo(url) {
    return new Promise(async (resolve, reject) => {
        try {
            const args = [
                '--dump-json',
                '--no-warnings',
                '--ignore-errors',
                '--no-check-certificate',
                ...getYoutubeHeaders(),
                url
            ];
            const { stdout, stderr } = await spawnYtdlp(args, { stdio: ['ignore', 'pipe', 'pipe'] });
            try {
                const firstBrace = stdout.indexOf('{');
                const jsonText = firstBrace >= 0 ? stdout.slice(firstBrace) : stdout;
                const info = JSON.parse(jsonText);
                resolve({
                    title: info.title || 'Untitled Video',
                    uploader: info.uploader || 'Unknown',
                    thumbnail: info.thumbnail || ''
                });
            } catch (parseErr) {
                reject(new Error('Failed to parse yt-dlp JSON: ' + tail(stderr, 120)));
            }
        } catch (err) {
            reject(err);
        }
    });
}

// ---------- helpers ----------
function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(views) {
    if (!views) return '0 views';
    const count = parseInt(views);
    if (isNaN(count)) return '0 views';
    if (count > 1000000) return `${(count / 1000000).toFixed(1)}M views`;
    if (count > 1000) return `${(count / 1000).toFixed(1)}K views`;
    return `${count} views`;
}

function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    try {
        if (/^\d{8}$/.test(dateStr)) {
            const year = dateStr.substring(0, 4);
            const month = dateStr.substring(4, 6);
            const day = dateStr.substring(6, 8);
            return new Date(`${year}-${month}-${day}`).toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric'
            });
        }
        return new Date(dateStr).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    } catch (e) {
        return 'Unknown';
    }
}

// Serve static UI and downloads
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(downloadsDir, {
    setHeaders: (res, filePath) => {
        res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    }
}));

// Basic health endpoint
app.get('/api/probe', (req, res) => {
    res.json({
        yt_dlp: { path: ytDlpCommand, exists: fs.existsSync(ytDlpCommand) },
        ffmpeg: { path: ffmpegCommand, exists: fs.existsSync(path.join(binDir, 'ffmpeg')) },
        cookie_file: { path: cookieFilePath, exists: fs.existsSync(cookieFilePath) }
    });
});

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('unhandledRejection:', err);
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT} (port ${PORT})`);
});

