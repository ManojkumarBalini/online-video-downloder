#!/usr/bin/env bash
set -euo pipefail

# Set correct permissions for directories
mkdir -p ./bin ./downloads
chmod -R 755 ./bin ./downloads

# Install yt-dlp
echo "Installing yt-dlp into ./bin/yt-dlp..."
curl -L -o ./bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
chmod +x ./bin/yt-dlp

# Install ffmpeg
echo "Installing ffmpeg into ./bin/ffmpeg..."
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

tmpdir=$(mktemp -d)
curl -L -o "$tmpdir/ffmpeg.tar.xz" "$FFMPEG_URL"

# extract
mkdir -p "$tmpdir/extracted"
tar -xf "$tmpdir/ffmpeg.tar.xz" -C "$tmpdir/extracted"

# find the extracted dir that contains ffmpeg
ffdir=$(find "$tmpdir/extracted" -maxdepth 1 -type d -name "ffmpeg*" | head -n 1)
if [ -z "$ffdir" ]; then
  echo "ERROR: ffmpeg directory not found inside archive"
  ls -la "$tmpdir/extracted"
  exit 1
fi

# copy binaries
cp "$ffdir/ffmpeg" ./bin/ffmpeg || true
cp "$ffdir/ffprobe" ./bin/ffprobe || true
chmod +x ./bin/ffmpeg ./bin/ffprobe || true

# cleanup
rm -rf "$tmpdir"

echo "✅ Binaries installed successfully into ./bin:"
ls -lh ./bin || true

