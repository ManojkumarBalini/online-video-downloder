#!/usr/bin/env bash
set -euo pipefail

# Installs yt-dlp and a static ffmpeg into ./bin so runtime path is predictable.
# Render runs this script during build if your service build command uses it.

mkdir -p ./bin

echo "Installing yt-dlp into ./bin/yt-dlp..."
curl -L -o ./bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
chmod +x ./bin/yt-dlp

# Install a static ffmpeg build (johnvansickle's static build)
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

echo "Binaries installed into ./bin:"
ls -lh ./bin || true

# Make sure build artifacts are preserved (if you have any frontend build steps, run them here)
# Example: npm run build

exit 0
