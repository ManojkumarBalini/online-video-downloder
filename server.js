const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const util = require('util');
const os = require('os');
const axios = require('axios');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);
const promisifiedExec = util.promisify(require('child_process').exec);

const app = express();
const PORT = 3000;
app.use(express.json());

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

const progressEmitter = new EventEmitter();

// Use system-installed binaries
const ffmpegCommand = 'ffmpeg';
const ytDlpCommand = 'yt-dlp';

// Startup checks
async function checkCmdVersion(cmd, args = ['--version']) {
    try {
        const { stdout, stderr } = await promisifiedExec(`${cmd} ${args.join(' ')}`);
        if (stderr) return { ok: true, version: stderr.split('\n')[0] || '' };
        return { ok: true, version: stdout.split('\n')[0] || '' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function init() {
    const ytCheck = await checkCmdVersion(ytDlpCommand);
    const ffCheck = await checkCmdVersion(ffmpegCommand);

    console.log('yt-dlp:', ytCheck);
    console.log('ffmpeg:', ffCheck);

    if (!ytCheck.ok) console.warn('⚠️ yt-dlp not found or not runnable by this Node process.');
    if (!ffCheck.ok) console.warn('⚠️ ffmpeg not found or not runnable by this Node process.');
}

init();

// Get video info endpoint
app.post('/api/info', async (req, res) => {
    const videoUrl = req.body.url;
    if (!videoUrl) return res.status(400).json({ error: 'Missing URL' });

    try {
        const args = [
            '--dump-json',
            '--no-warnings',
            '--ignore-errors',
            '--no-check-certificates',
            videoUrl
        ];

        const proc = spawn(ytDlpCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let data = '';
        let errorOutput = '';

        proc.stdout.on('data', (chunk) => {
            data += chunk.toString();
        });

        proc.stderr.on('data', (chunk) => {
            errorOutput += chunk.toString();
        });

        proc.on('error', (err) => {
            console.error('yt-dlp spawn error:', err);
            return res.status(500).json({ error: 'Failed to start yt-dlp', details: err.message });
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                console.error('yt-dlp error:', errorOutput || `exit code ${code}`);
                return res.status(500).json({ error: 'Failed to get video info', details: errorOutput || `exit code ${code}` });
            }

            try {
                const info = JSON.parse(data);

                // Filter out formats with no size or invalid data
                const videoFormats = (info.formats || [])
                    .filter(f => f.vcodec !== 'none' && (f.filesize || f.filesize_approx))
                    .map(f => {
                        let sizeMB = 0;
                        if (f.filesize) {
                            sizeMB = Math.round(f.filesize / (1024 * 1024));
                        } else if (f.filesize_approx) {
                            sizeMB = Math.round(f.filesize_approx / (1024 * 1024));
                        }

                        return {
                            resolution: f.format_note || (f.height ? `${f.height}p` : 'Unknown'),
                            codec: [f.vcodec, f.acodec].filter(Boolean).join('+'),
                            container: f.ext,
                            sizeMB: sizeMB,
                            bitrate: f.tbr || 0,
                            itag: f.format_id,
                            hasAudio: f.acodec !== 'none'
                        };
                    })
                    .sort((a, b) => {
                        const aRes = parseInt(a.resolution) || 0;
                        const bRes = parseInt(b.resolution) || 0;
                        return bRes - aRes;
                    });

                const audioFormats = (info.formats || [])
                    .filter(f => f.acodec !== 'none' && f.vcodec === 'none' && (f.filesize || f.filesize_approx))
                    .map(f => ({
                        itag: f.format_id,
                        bitrate: f.tbr || 0,
                        container: f.ext
                    }))
                    .sort((a, b) => b.bitrate - a.bitrate);

                let date = 'Unknown';
                if (info.upload_date) {
                    date = formatDate(info.upload_date);
                } else if (info.release_timestamp) {
                    date = new Date(info.release_timestamp * 1000).toLocaleDateString();
                }

                res.json({
                    title: info.title || 'Untitled Video',
                    thumbnail: info.thumbnail || 'https://via.placeholder.com/800x450',
                    duration: formatDuration(info.duration || 0),
                    views: formatViews(info.view_count || 0),
                    date: date,
                    formats: videoFormats,
                    audioFormats: audioFormats,
                    uploader: info.uploader || 'Unknown'
                });
            } catch (parseError) {
                console.error('JSON parse error:', parseError);
                res.status(500).json({ error: 'Failed to parse video info', details: parseError.message });
            }
        });
    } catch (err) {
        console.error('Video info error:', err);
        res.status(500).json({ error: 'Failed to get video info', details: err.message });
    }
});

// SSE endpoint for progress updates
app.get('/api/download/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const progressHandler = (data) => {
        res.write(`event: progress\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    progressEmitter.on('progress', progressHandler);

    req.on('close', () => {
        progressEmitter.off('progress', progressHandler);
        try { res.end(); } catch (e) { /* ignore */ }
    });
});

// embedMetadata: downloads thumbnail if needed, then attaches it as cover art
const embedMetadata = async (filePath, metadata) => {
    const tempPath = path.join(downloadsDir, `meta_temp_${path.basename(filePath)}`);
    let thumbPath = null;

    // helper to download thumbnail
    async function downloadToFile(url, dest) {
        const response = await axios.get(url, { responseType: 'stream', timeout: 15000 });
        await pipeline(response.data, fs.createWriteStream(dest));
    }

    try {
        // Only fetch thumbnail if it's a URL
        if (metadata && metadata.thumbnail && /^https?:\/\//i.test(metadata.thumbnail)) {
            thumbPath = path.join(downloadsDir, `thumb_${uuidv4()}.jpg`);
            try {
                await downloadToFile(metadata.thumbnail, thumbPath);
            } catch (dlErr) {
                console.warn('Thumbnail download failed, continuing without cover:', dlErr.message);
                thumbPath = null;
            }
        } else if (metadata && metadata.thumbnail && fs.existsSync(metadata.thumbnail)) {
            // If thumbnail is already a local file path
            thumbPath = metadata.thumbnail;
        }

        // Build ffmpeg args
        let args;
        if (thumbPath) {
            // Use two inputs: 0 = original, 1 = thumbnail
            args = [
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
            // No thumbnail — just write metadata
            args = [
                '-i', filePath,
                '-c', 'copy',
                '-metadata', `title=${metadata.title || ''}`,
                '-metadata', `artist=${metadata.artist || ''}`,
                '-metadata', `comment=Downloaded with Online Downloader`,
                tempPath
            ];
        }

        // Run ffmpeg and capture stderr (for debugging)
        await new Promise((resolve, reject) => {
            const ff = spawn(ffmpegCommand, args);
            let stderr = '';

            ff.stderr.on('data', (d) => { stderr += d.toString(); });
            ff.on('error', (err) => reject(err));
            ff.on('close', (code) => {
                if (code === 0) {
                    try {
                        // replace original file with temp
                        fs.renameSync(tempPath, filePath);
                        // cleanup thumbnail (only if we created it)
                        if (thumbPath && thumbPath.includes('thumb_') && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
                    } catch (e) {
                        console.warn('embedMetadata: cleanup or rename error:', e);
                    }
                    resolve();
                } else {
                    // include stderr in error for easier debugging
                    const msg = `FFmpeg exited with code ${code}. Stderr: ${stderr}`;
                    reject(new Error(msg));
                }
            });
        });

    } catch (err) {
        // rethrow so caller knows embedding failed
        throw err;
    }
};

// Download endpoint with metadata embedding
app.post('/api/download', async (req, res) => {
    const { url, videoItag, audioItag } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    const id = uuidv4();
    const baseOutput = path.join(downloadsDir, id);
    const finalFilePath = `${baseOutput}.mp4`;

    // Build arguments
    let args = [
        '--no-warnings',
        '--ignore-errors',
        '--no-check-certificates',
        '--console-title',
        '--newline',
        '--progress',
        '--ffmpeg-location', '/usr/bin',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        '--no-playlist',
        '-o', `${baseOutput}.%(ext)s`,
        url
    ];

    if (videoItag && audioItag) {
        args.push('-f', `${videoItag}+${audioItag}`);
    } else if (videoItag) {
        args.push('-f', `${videoItag}`);
    } else {
        args.push('-f', 'bestvideo+bestaudio');
    }

    args.push('--merge-output-format', 'mp4', '--postprocessor-args', '-c:v copy -c:a aac -b:a 192k');

    const filteredArgs = args.filter(arg => arg !== undefined && arg !== null && String(arg).trim() !== '');

    console.log('Starting download with args:', filteredArgs);

    // Retry mechanism
    const maxRetries = 3;
    let retryCount = 0;
    let downloadSuccess = false;

    const attemptDownload = () => {
        return new Promise((resolve, reject) => {
            const proc = spawn(ytDlpCommand, filteredArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Progress regex
            const progressRegex = /(\d+(?:\.\d+)?)%/;

            proc.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                console.log('[yt-dlp stdout]', text.trim());

                const progressMatch = text.match(progressRegex);
                if (progressMatch) {
                    const progress = parseFloat(progressMatch[1]);
                    progressEmitter.emit('progress', { progress });
                }

                if (text.includes('Destination:') || text.includes('[download] Destination:')) {
                    progressEmitter.emit('progress', { status: 'Downloading...' });
                }

                if (text.includes('100%')) {
                    progressEmitter.emit('progress', { progress: 100, status: 'Finalizing...' });
                }
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                console.error('[yt-dlp stderr]', text.trim());

                const progressMatch = text.match(progressRegex);
                if (progressMatch) {
                    const progress = parseFloat(progressMatch[1]);
                    progressEmitter.emit('progress', { progress });
                }
            });

            const killTimeout = setTimeout(() => {
                try { proc.kill(); } catch (e) { /* ignore */ }
                progressEmitter.emit('progress', { error: 'Download timed out' });
                reject(new Error('Download timed out'));
            }, 1000 * 60 * 15); // 15 minutes

            proc.on('close', (code) => {
                clearTimeout(killTimeout);
                console.log(`Download process closed with code ${code}`);

                if (code !== 0) {
                    progressEmitter.emit('progress', {
                        error: 'Download failed',
                        details: `Exit code: ${code}`
                    });
                    reject(new Error(`Download failed with code ${code}`));
                    return;
                }

                if (!fs.existsSync(finalFilePath)) {
                    progressEmitter.emit('progress', { error: 'File not created' });
                    reject(new Error('File not created'));
                    return;
                }

                resolve();
            });

            proc.on('error', (err) => {
                clearTimeout(killTimeout);
                console.error('Download process error:', err);
                progressEmitter.emit('progress', { error: 'Failed to start download' });
                reject(err);
            });
        });
    };

    while (retryCount < maxRetries && !downloadSuccess) {
        try {
            await attemptDownload();
            downloadSuccess = true;
        } catch (err) {
            retryCount++;
            console.error(`Download attempt ${retryCount} failed:`, err.message);
            progressEmitter.emit('progress', { 
                status: `Retrying download... (${retryCount}/${maxRetries})`,
                progress: 0
            });
            
            if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                return res.status(500).json({ error: 'Download failed after retries', details: err.message });
            }
        }
    }

    try {
        // Embed metadata
        const videoInfo = await new Promise((resolve, reject) => {
            // We need to refetch the video info for metadata
            fetchVideoInfo(url)
                .then(info => resolve(info))
                .catch(err => reject(err));
        });

        await embedMetadata(finalFilePath, {
            title: videoInfo.title,
            artist: videoInfo.uploader,
            thumbnail: videoInfo.thumbnail
        });
    } catch (metaErr) {
        console.warn('Metadata embedding failed:', metaErr);
    }

    // Clean up temporary files
    const files = fs.readdirSync(downloadsDir);
    files.forEach(file => {
        if (file.startsWith(id) && !file.endsWith('.mp4')) {
            try {
                fs.unlinkSync(path.join(downloadsDir, file));
            } catch (cleanupErr) {
                console.warn('Failed to clean up temp file:', cleanupErr);
            }
        }
    });

    progressEmitter.emit('progress', { complete: true, file: `${id}.mp4` });
    res.json({ success: true, file: `${id}.mp4` });
});

// Helper to fetch video info for metadata
async function fetchVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '--dump-json',
            '--no-warnings',
            '--ignore-errors',
            '--no-check-certificates',
            url
        ];

        const proc = spawn(ytDlpCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let data = '';
        let errorOutput = '';

        proc.stdout.on('data', (chunk) => {
            data += chunk.toString();
        });

        proc.stderr.on('data', (chunk) => {
            errorOutput += chunk.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(errorOutput || `exit code ${code}`));
            }

            try {
                const info = JSON.parse(data);
                resolve({
                    title: info.title || 'Untitled Video',
                    uploader: info.uploader || 'Unknown',
                    thumbnail: info.thumbnail || ''
                });
            } catch (parseError) {
                reject(parseError);
            }
        });
    });
}

// Helper functions
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
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        }

        return new Date(dateStr).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch (e) {
        return 'Unknown';
    }
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(downloadsDir, {
    setHeaders: (res, filePath) => {
        res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    }
}));

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});
