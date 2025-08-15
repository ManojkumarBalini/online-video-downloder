#!/bin/bash

# Create bin directory
mkdir -p bin

# Install yt-dlp
echo "Installing yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod a+rx bin/yt-dlp

# Install ffmpeg
echo "Installing ffmpeg..."
curl -L -o ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
tar -xf ffmpeg.tar.xz
find . -type f -name ffmpeg -exec mv {} bin/ \;
chmod a+rx bin/ffmpeg

# Cleanup
rm -rf ffmpeg-master-latest-linux64-gpl ffmpeg.tar.xz

echo "Binaries installed:"
ls -lh bin/
