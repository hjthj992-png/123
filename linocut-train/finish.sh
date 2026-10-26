#!/usr/bin/env bash
# Mux sound, downscale (supersample AA) and build a vertical 9:16 cut for TikTok/Reels/Shorts.
set -euo pipefail
cd "$(dirname "$0")/out"
FONT=/usr/share/fonts/opentype/inter/Inter-Bold.otf

ffmpeg -y -loglevel error -i film_raw.mp4 -i sound.wav \
  -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart linocut_express_16x9.mp4

ffmpeg -y -loglevel error -i film_raw.mp4 -i sound.wav -filter_complex "
  color=c=0x0d0d10:s=1080x1920:r=30[bg];
  [0:v]scale=1080:-2:flags=lanczos[v];
  [bg][v]overlay=0:(H-h)/2-60:shortest=1,
  drawtext=fontfile=$FONT:text='Can you believe this is code?':fontcolor=white:fontsize=58:x=(w-tw)/2:y=560,
  drawtext=fontfile=$FONT:text='Three.js · GLSL · zero images':fontcolor=0xd3242a:fontsize=36:x=(w-tw)/2:y=1330" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart linocut_express_9x16.mp4
echo done
