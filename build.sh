#!/bin/bash

# Create bin directory
mkdir -p bin

# Install yt-dlp
echo "Installing yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod a+rx bin/yt-dlp

# Install ffmpeg (fixed URL)
echo "Installing ffmpeg..."
curl -L -o ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2024-08-26-14-00/ffmpeg-N-115001-g0d00e1c3a1-linux64-gpl.tar.xz"
tar -xf ffmpeg.tar.xz
find . -type d -name "ffmpeg-*" -exec mv {}/ffmpeg bin/ \;
chmod a+rx bin/ffmpeg

# Cleanup
rm -rf ffmpeg-* ffmpeg.tar.xz

echo "Binaries installed:"
ls -lh bin/
