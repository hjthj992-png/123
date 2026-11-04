# Breathing-guide video generator

Makes 9:16 vertical breathing videos for TikTok, Reels and Shorts. A ball rides a scrolling line: it rises while you breathe in, stays flat while you hold, and falls while you breathe out. The caption changes with each phase, a countdown sits above the ball, and the soundtrack (drone, breath sound, chimes) is generated to match.

Requires Python 3, `numpy`, `Pillow` and `ffmpeg`.

```bash
pip install numpy pillow          # ffmpeg: brew install ffmpeg / apt install ffmpeg

python breath_video.py list                                   # patterns and scenes
python breath_video.py one --pattern 4-7-8 --scene night --brand "My App" --out a.mp4
python breath_video.py one --pattern box --bg photo.jpg --out b.mp4      # your own background
python breath_video.py one --pattern box --preview --out frame.png       # one frame, fast

# many variations plus captions.csv (post text with hook, CTA and hashtags)
python breath_video.py batch --count 30 --out-dir out --brand "My App" \
    --cta "Free breathing app: link in bio" --bg-dir my_photos/
```

Patterns: box, 4-7-8, coherent, vagus, calm, sleep, focus, anxiety. Add your own to `PATTERNS` at the top of the script.
Scenes: sunset, night, aurora, ocean, dusk (generated), or any photo with `--bg` / `--bg-dir`.
Options: `--duration` (seconds, default 60), `--music file.mp3`, `--speed` (line scroll speed), `--jobs` (parallel renders).

Speed: about 8 frames/s per CPU core, so a 60 s video takes about 3–4 minutes on one core. `batch` uses every core.
