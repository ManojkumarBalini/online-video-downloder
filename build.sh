#!/usr/bin/env bash
set -euo pipefail

# Try to install system packages (if the builder environment allows apt-get).
# This gives us a PATH-based ffmpeg/yt-dlp as a fallback.
if command -v apt-get >/dev/null 2>&1; then
  echo "Attempting apt-get install of ffmpeg..."
  apt-get update || true
  apt-get install -y ffmpeg || true

  echo "Attempting to install yt-dlp to /usr/local/bin..."
  curl -L -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" || true
  chmod +x /usr/local/bin/yt-dlp || true
fi

# Ensure ./bin exists
mkdir -p ./bin

echo "Installing yt-dlp into ./bin/yt-dlp (fallback) ..."
curl -L -o ./bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
chmod +x ./bin/yt-dlp || true

# Install a static ffmpeg build into ./bin (johnvansickle's static build)
echo "Installing static ffmpeg into ./bin/ffmpeg (fallback)..."
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
else
  cp "$ffdir/ffmpeg" ./bin/ffmpeg || true
  cp "$ffdir/ffprobe" ./bin/ffprobe || true
  chmod +x ./bin/ffmpeg ./bin/ffprobe || true
fi

# cleanup
rm -rf "$tmpdir"

echo "Binaries installed into ./bin:"
ls -lh ./bin || true

echo "Build script finished."
exit 0

