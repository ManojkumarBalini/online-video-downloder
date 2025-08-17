#!/usr/bin/env bash
set -euo pipefail

mkdir -p ./bin

echo "Installing yt-dlp into ./bin/yt-dlp..."
curl -L -o ./bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
chmod +x ./bin/yt-dlp

FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

tmpdir=$(mktemp -d)
curl -L -o "$tmpdir/ffmpeg.tar.xz" "$FFMPEG_URL"

mkdir -p "$tmpdir/extracted"
tar -xf "$tmpdir/ffmpeg.tar.xz" -C "$tmpdir/extracted"

ffdir=$(find "$tmpdir/extracted" -maxdepth 1 -type d -name "ffmpeg*" | head -n 1)
if [ -z "$ffdir" ]; then
  echo "ERROR: ffmpeg directory not found inside archive"
  ls -la "$tmpdir/extracted"
  exit 1
fi

cp "$ffdir/ffmpeg" ./bin/ffmpeg || true
cp "$ffdir/ffprobe" ./bin/ffprobe || true
chmod +x ./bin/ffmpeg ./bin/ffprobe || true

rm -rf "$tmpdir"

echo "Binaries installed into ./bin:"
ls -lh ./bin || true

exit 0

