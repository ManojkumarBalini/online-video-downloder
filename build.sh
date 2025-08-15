#!/bin/bash

# Create bin directory
mkdir -p bin

# Install yt-dlp
echo "Installing yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod a+rx bin/yt-dlp

# Install required Python packages for HTTPS proxy support
echo "Installing Python dependencies..."
pip install requests

# Install ffmpeg
echo "Installing ffmpeg..."
curl -L -o ffmpeg.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
tar -xf ffmpeg.tar.xz
find . -name ffmpeg -exec mv {} bin/ \;
chmod a+rx bin/ffmpeg

# Cleanup
rm -rf ffmpeg-* ffmpeg.tar.xz

echo "Binaries installed:"
ls -lh bin/
