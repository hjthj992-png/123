#!/usr/bin/env python3
"""
Breathing-guide video generator (9:16, TikTok / Reels / Shorts).

A ball rides a scrolling line: it rises while you breathe in, stays flat
while you hold, and falls while you breathe out. The caption at the top
changes with each phase. Backgrounds are generated procedurally, or you can
pass your own image with --bg.

Examples
  python breath_video.py one --pattern box --scene sunset --out box.mp4
  python breath_video.py one --pattern 4-7-8 --scene night --duration 45 --brand "Calm App"
  python breath_video.py batch --count 20 --out-dir out --brand "Calm App"
  python breath_video.py list
"""
import argparse
import csv
import math
import os
import random
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
FPS = 30

# ---------------------------------------------------------------- patterns
# Each pattern is a list of (phase, seconds). phase in: in, hold_in, out, hold_out
PATTERNS = {
    "box": {"title": "Box Breathing", "sub": "4-4-4-4",
            "phases": [("in", 4), ("hold_in", 4), ("out", 4), ("hold_out", 4)]},
    "4-7-8": {"title": "Breathing for Stress", "sub": "4-7-8",
              "phases": [("in", 4), ("hold_in", 7), ("out", 8)]},
    "coherent": {"title": "Coherent Breathing", "sub": "5.5 in · 5.5 out",
                 "phases": [("in", 5.5), ("out", 5.5)]},
    "vagus": {"title": "Vagus Nerve Reset", "sub": "1 Minute",
              "phases": [("in", 4), ("hold_in", 2), ("out", 8)]},
    "calm": {"title": "Nervous System Reset", "sub": "4 in · 6 out",
             "phases": [("in", 4), ("out", 6)]},
    "sleep": {"title": "Breathe to Fall Asleep", "sub": "4-7-8",
              "phases": [("in", 4), ("hold_in", 7), ("out", 8)]},
    "focus": {"title": "Reset Your Focus", "sub": "Box 5-5-5-5",
              "phases": [("in", 5), ("hold_in", 5), ("out", 5), ("hold_out", 5)]},
    "anxiety": {"title": "Calm Anxiety Fast", "sub": "Extended exhale",
                "phases": [("in", 3), ("hold_in", 1), ("out", 6), ("hold_out", 1)]},
}

CAPTIONS = {
    "in": ("Breathe in", "when the ball goes up"),
    "hold_in": ("Hold", "when it stays flat"),
    "out": ("Breathe out", "when the ball goes down"),
    "hold_out": ("Hold", "when it stays flat"),
}

SCENES = ["sunset", "night", "aurora", "ocean", "dusk"]

BALL_COLORS = [(245, 190, 60), (240, 230, 140), (255, 255, 255), (255, 150, 120), (140, 220, 255)]

# ---------------------------------------------------------------- fonts
def _font(size, weight="Bold"):
    for p in (f"/usr/share/fonts/opentype/inter/Inter-{weight}.otf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/Library/Fonts/Arial Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


# ---------------------------------------------------------------- backgrounds
def _grad(stops, h):
    """Vertical gradient from list of (pos 0..1, (r,g,b)) -> (h,3) float array."""
    ys = np.linspace(0, 1, h)
    out = np.zeros((h, 3))
    pos = [s[0] for s in stops]
    for c in range(3):
        out[:, c] = np.interp(ys, pos, [s[1][c] for s in stops])
    return out


def _vignette():
    y, x = np.mgrid[0:H, 0:W]
    d = np.sqrt(((x - W / 2) / (W * 0.75)) ** 2 + ((y - H / 2) / (H * 0.7)) ** 2)
    return np.clip(1.05 - 0.45 * d ** 2, 0.45, 1.0)[..., None]


class Scene:
    """Static base image plus cheap per-frame animation."""

    def __init__(self, name, rng, bg_path=None):
        self.name = name
        self.rng = rng
        self.vig = _vignette()
        if bg_path:
            img = Image.open(bg_path).convert("RGB")
            s = max(W / img.width, H / img.height)
            img = img.resize((int(img.width * s) + 1, int(img.height * s) + 1), Image.LANCZOS)
            l, t = (img.width - W) // 2, (img.height - H) // 2
            base = np.asarray(img.crop((l, t, l + W, t + H))).astype(np.float32)
            self.base = base * 0.75  # darken slightly so text pops
            self.kind = "image"
        else:
            self.kind = name
            getattr(self, f"_build_{name}")()
        self.base = np.clip(self.base * self.vig, 0, 255)

    # --- builders
    def _sky(self, stops):
        g = _grad(stops, H)
        return np.repeat(g[:, None, :], W, axis=1).astype(np.float32)

    def _stars(self, n, ymax):
        r = self.rng
        self.stars = [(r.uniform(0, W), r.uniform(0, ymax), r.uniform(0.6, 2.4),
                       r.uniform(0, 2 * math.pi), r.uniform(0.5, 2.0)) for _ in range(n)]

    def _disc(self, arr, cx, cy, rad, color, glow):
        y, x = np.mgrid[0:H, 0:W]
        d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
        core = np.clip(rad + 1 - d, 0, 1)[..., None]
        halo = (np.exp(-np.maximum(d - rad, 0) / glow) * 0.55)[..., None]
        col = np.array(color, np.float32)
        arr[:] = arr * (1 - core) + col * core
        arr[:] = arr + col * halo * (1 - core)

    def _mountains(self, arr, base_y, amp, color, seed):
        r = np.random.default_rng(seed)
        xs = np.arange(W)
        y = base_y + sum(amp / (k + 1) * np.sin(xs / W * math.pi * (k + 1) * r.uniform(1, 3) + r.uniform(0, 6))
                         for k in range(5))
        mask = (np.arange(H)[:, None] > y[None, :])
        arr[mask] = color

    def _build_sunset(self):
        a = self._sky([(0, (40, 30, 80)), (0.3, (200, 90, 110)), (0.47, (255, 170, 90)),
                       (0.5, (255, 200, 140)), (0.52, (60, 70, 110)), (1, (15, 20, 45))])
        self._disc(a, W * 0.5, H * 0.47, 90, (255, 215, 150), 120)
        horizon = int(H * 0.5)
        a[horizon:] = _grad([(0, (90, 80, 120)), (0.3, (45, 55, 95)), (1, (12, 18, 40))], H - horizon)[:, None, :]
        self._mountains(a, H * 0.47, 60, (60, 40, 70), 3)
        self.horizon = horizon
        self.base = a

    def _build_night(self):
        a = self._sky([(0, (5, 8, 25)), (0.6, (15, 30, 70)), (1, (25, 45, 90))])
        self._disc(a, W * 0.78, H * 0.33, 95, (235, 235, 220), 90)
        self._mountains(a, H * 0.82, 70, (8, 12, 28), 7)
        self._stars(260, H * 0.8)
        self.base = a

    def _build_aurora(self):
        a = self._sky([(0, (3, 12, 22)), (0.7, (8, 30, 45)), (1, (10, 40, 50))])
        self._mountains(a, H * 0.85, 80, (4, 10, 16), 11)
        self._stars(160, H * 0.85)
        # aurora texture, twice as wide, rolled horizontally per frame
        xs = np.linspace(0, 4 * math.pi, W * 2)
        ys = np.arange(H)[:, None]
        center = H * 0.33 + 120 * np.sin(xs * 0.9) + 60 * np.sin(xs * 2.3 + 1)
        band = np.exp(-((ys - center[None, :]) / 140) ** 2) * (0.6 + 0.4 * np.sin(xs * 6)[None, :] ** 2)
        self.aurora = (band[..., None] * np.array([60, 230, 160], np.float32) * 0.7).astype(np.float32)
        self.base = a

    def _build_ocean(self):
        a = self._sky([(0, (120, 190, 230)), (0.36, (190, 225, 245)), (0.4, (40, 120, 170)),
                       (1, (5, 35, 70))])
        self.horizon = int(H * 0.38)
        self._mountains(a, H * 0.36, 40, (70, 110, 140), 5)
        self.base = a

    def _build_dusk(self):
        a = self._sky([(0, (25, 20, 60)), (0.5, (110, 70, 140)), (0.75, (240, 140, 120)), (1, (250, 190, 140))])
        self._mountains(a, H * 0.7, 90, (70, 50, 100), 21)
        self._mountains(a, H * 0.78, 70, (45, 30, 70), 22)
        self._mountains(a, H * 0.87, 50, (25, 15, 40), 23)
        self._stars(90, H * 0.4)
        self.base = a

    # --- per-frame
    def frame(self, t):
        f = self.base.copy()
        if self.kind in ("sunset", "ocean"):
            hz = self.horizon
            rows = np.arange(H - hz)
            shimmer = 1 + 0.06 * np.sin(rows * 0.35 - t * 2.0) * np.sin(rows * 0.05 + t * 0.7)
            f[hz:] *= shimmer[:, None, None]
            if self.kind == "sunset":  # sun reflection column
                cols = np.exp(-((np.arange(W) - W / 2) / 70) ** 2)
                refl = (0.5 + 0.5 * np.sin(rows * 0.6 - t * 3)) * np.exp(-rows / 500)
                f[hz:] += (refl[:, None] * cols[None, :])[..., None] * np.array([120, 90, 50], np.float32)
        if self.kind == "aurora":
            off = int(t * 25) % W
            f += self.aurora[:, off:off + W] * (0.8 + 0.2 * math.sin(t * 0.6))
        img = Image.fromarray(np.clip(f, 0, 255).astype(np.uint8))
        if hasattr(self, "stars"):
            d = ImageDraw.Draw(img)
            for x, y, r, ph, sp in self.stars:
                b = int(150 + 105 * math.sin(t * sp + ph))
                d.ellipse((x - r, y - r, x + r, y + r), fill=(b, b, min(255, b + 20)))
        return img


# ---------------------------------------------------------------- path / ball
class Breath:
    def __init__(self, phases):
        self.phases = phases
        self.cycle = sum(d for _, d in phases)
        # vertices in one cycle: (time, level 0=low 1=high)
        self.verts = []
        t, lvl = 0.0, 0.0
        self.verts.append((t, lvl))
        for ph, d in phases:
            t += d
            if ph == "in":
                lvl = 1.0
            elif ph == "out":
                lvl = 0.0
            self.verts.append((t, lvl))

    def level(self, t):
        tc = t % self.cycle
        for (t0, l0), (t1, l1) in zip(self.verts, self.verts[1:]):
            if t0 <= tc <= t1:
                return l0 + (l1 - l0) * (tc - t0) / (t1 - t0)
        return 0.0

    def phase_at(self, t):
        tc = t % self.cycle
        acc = 0.0
        for ph, d in self.phases:
            if tc < acc + d:
                return ph, d - (tc - acc)
            acc += d
        return self.phases[-1][0], 0

    def vertices_between(self, a, b):
        out = []
        k0 = math.floor(a / self.cycle) - 1
        k1 = math.ceil(b / self.cycle) + 1
        for k in range(k0, k1 + 1):
            for vt, vl in self.verts[:-1]:
                tt = k * self.cycle + vt
                if a <= tt <= b:
                    out.append((tt, vl))
        return sorted(out)


def ball_sprite(radius, color, ss=4):
    size = int(radius * 4)
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    c = size * ss / 2
    r = radius * ss
    d.ellipse((c - r * 1.6, c - r * 1.6, c + r * 1.6, c + r * 1.6), fill=color + (70,))
    big = big.filter(ImageFilter.GaussianBlur(r * 0.5))
    d = ImageDraw.Draw(big)
    d.ellipse((c - r, c - r, c + r, c + r), fill=color + (255,))
    return big.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------- text
def draw_text_center(img, text, y, font, fill=(255, 255, 255), stroke=6):
    d = ImageDraw.Draw(img)
    w = d.textlength(text, font=font)
    d.text(((W - w) / 2, y), text, font=font, fill=fill, stroke_width=stroke, stroke_fill=(0, 0, 0, 170))


# ---------------------------------------------------------------- audio
def make_audio(path, breath, duration, sr=44100, seed=0):
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    t = np.arange(n) / sr
    # warm drone
    drone = sum(a * np.sin(2 * np.pi * f * t + p) for f, a, p in
                [(110, 0.10, 0), (164.8, 0.06, 1), (220, 0.04, 2), (329.6, 0.02, 3)])
    drone *= 0.8 + 0.2 * np.sin(2 * np.pi * 0.07 * t)
    # breath-like filtered noise following the ball
    noise = rng.standard_normal(n)
    k = 60
    noise = np.convolve(noise, np.ones(k) / k, mode="same")
    noise /= np.abs(noise).max() + 1e-9
    lvl = np.array([breath.level(x) for x in t[::441]])
    lvl = np.interp(np.arange(n), np.arange(len(lvl)) * 441, lvl)
    vel = np.abs(np.gradient(lvl)) * sr
    env = np.clip(vel / (vel.max() + 1e-9), 0, 1) ** 0.7
    env = np.convolve(env, np.ones(4410) / 4410, mode="same")
    whoosh = noise * env * 0.18
    # soft chime on each phase change
    chime = np.zeros(n)
    tt, i = 0.0, 0
    while tt < duration:
        ph, d = breath.phases[i % len(breath.phases)]
        s = int(tt * sr)
        L = min(int(2.5 * sr), n - s)
        if L > 0:
            tl = np.arange(L) / sr
            f = 660 if ph == "in" else 523.25 if ph == "out" else 587.3
            chime[s:s + L] += 0.08 * np.sin(2 * np.pi * f * tl) * np.exp(-tl * 2.2)
        tt += d
        i += 1
    mix = drone + whoosh + chime
    fade = int(1.5 * sr)
    mix[:fade] *= np.linspace(0, 1, fade)
    mix[-fade:] *= np.linspace(1, 0, fade)
    mix = mix / (np.abs(mix).max() + 1e-9) * 0.8
    pcm = (mix * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- render
def render(out, pattern="box", scene="sunset", duration=60, brand="", seed=0,
           bg=None, music=None, ball_color=None, speed=150, fps=FPS, preview=False):
    rng = random.Random(seed)
    p = PATTERNS[pattern]
    breath = Breath(p["phases"])
    sc = Scene(scene, rng, bg)
    ball_color = tuple(ball_color) if ball_color else rng.choice(BALL_COLORS)
    sprite = ball_sprite(34, ball_color)

    y_hi, y_lo = 760, 1260
    ball_x = W // 2
    band_top, band_bot = y_hi - 120, y_lo + 120
    SS = 2

    f_big = _font(96, "ExtraBold")
    f_mid = _font(58, "Bold")
    f_title = _font(54, "ExtraBold")
    f_sub = _font(64, "Black")
    f_brand = _font(38, "SemiBold")
    f_count = _font(40, "Bold")

    tmp_audio = out + ".wav"
    if music is None:
        make_audio(tmp_audio, breath, duration, seed=seed)
        audio_in = tmp_audio
    else:
        audio_in = music

    n_frames = 1 if preview else int(duration * fps)
    if preview:
        cmd = None
    else:
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
               "-i", audio_in, "-map", "0:v", "-map", "1:a", "-t", str(duration),
               "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "160k", "-af", f"afade=t=out:st={max(duration - 1.5, 0)}:d=1.5",
               "-movflags", "+faststart", out]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def y_of(level):
        return y_lo + (y_hi - y_lo) * level

    for i in range(n_frames):
        t = (duration * 0.3 if preview else i / fps)
        img = sc.frame(t).convert("RGBA")

        # --- path layer (supersampled band)
        bh = band_bot - band_top
        layer = Image.new("RGBA", (W * SS, bh * SS), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        t_left = t - ball_x / speed
        t_right = t + (W - ball_x) / speed
        pts = [(t_left, breath.level(t_left))] + breath.vertices_between(t_left, t_right) + \
              [(t_right, breath.level(t_right))]
        pts = [(ball_x + (tt - t) * speed, y_of(lv)) for tt, lv in pts]
        bx, by = ball_x, y_of(breath.level(t))
        past = [q for q in pts if q[0] <= bx] + [(bx, by)]
        fut = [(bx, by)] + [q for q in pts if q[0] > bx]

        def sc_pts(ps):
            return [(x * SS, (y - band_top) * SS) for x, y in ps]
        lw = 9 * SS
        if len(past) > 1:
            d.line(sc_pts(past), fill=(255, 255, 255, 110), width=lw, joint="curve")
        if len(fut) > 1:
            d.line(sc_pts(fut), fill=(255, 255, 255, 235), width=lw, joint="curve")
        layer = layer.resize((W, bh), Image.BOX)
        img.alpha_composite(layer, (0, band_top))

        # --- ball
        img.alpha_composite(sprite, (int(bx - sprite.width / 2), int(by - sprite.height / 2)))

        # --- captions
        ph, remaining = breath.phase_at(t)
        l1, l2 = CAPTIONS[ph]
        draw_text_center(img, l1, 300, f_big, stroke=7)
        draw_text_center(img, l2, 420, f_mid, stroke=6)
        cnt = str(max(1, math.ceil(remaining - 1e-6)))
        draw_text_center(img, cnt, by - 110, f_count, fill=(255, 255, 255, 230), stroke=4)

        draw_text_center(img, p["title"], 1470, f_title, stroke=6)
        draw_text_center(img, p["sub"], 1540, f_sub, fill=ball_color, stroke=7)
        if brand:
            draw_text_center(img, brand, 170, f_brand, fill=(255, 255, 255, 220), stroke=4)

        rgb = img.convert("RGB")
        if preview:
            rgb.save(out)
        else:
            proc.stdin.write(rgb.tobytes())

    if not preview:
        proc.stdin.close()
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg failed")
    if os.path.exists(tmp_audio):
        os.remove(tmp_audio)
    return out


# ---------------------------------------------------------------- captions for posting
HOOKS = [
    "Try this for 60 seconds and notice how you feel",
    "Your nervous system will thank you",
    "Follow the ball. Don't think, just breathe",
    "Save this for the next time anxiety hits",
    "Do this before bed tonight",
    "1 minute to calm down. Breathe with me",
]
TAGS = "#breathwork #breathing #anxietyrelief #calm #meditation #mentalhealth #selfcare"


def post_caption(pattern, rng, cta):
    p = PATTERNS[pattern]
    s = f"{rng.choice(HOOKS)} 🫁\n{p['title']} ({p['sub']})"
    if cta:
        s += f"\n{cta}"
    return s + f"\n\n{TAGS}"


def _render_task(args):
    path, pat, scn, dur, brand, seed, bg, music, speed = args
    return render(path, pat, scn, dur, brand, seed=seed, bg=bg, music=music, speed=speed)


# ---------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(a):
        a.add_argument("--duration", type=float, default=60)
        a.add_argument("--brand", default="", help="small text at the top, e.g. your app name")
        a.add_argument("--music", help="audio file to use instead of the generated soundtrack")
        a.add_argument("--speed", type=float, default=150, help="line scroll speed, px/s")

    one = sub.add_parser("one", help="render a single video")
    one.add_argument("--pattern", default="box", choices=PATTERNS)
    one.add_argument("--scene", default="sunset", choices=SCENES)
    one.add_argument("--bg", help="your own background image (overrides --scene)")
    one.add_argument("--seed", type=int, default=0)
    one.add_argument("--out", default="breath.mp4")
    one.add_argument("--preview", action="store_true", help="save one PNG frame instead of a video")
    common(one)

    b = sub.add_parser("batch", help="render many variations + captions.csv")
    b.add_argument("--count", type=int, default=10)
    b.add_argument("--out-dir", default="out")
    b.add_argument("--bg-dir", help="folder of background images to rotate through")
    b.add_argument("--cta", default="", help='line added to every caption, e.g. "Free app: link in bio"')
    b.add_argument("--seed", type=int, default=1)
    b.add_argument("--jobs", type=int, default=os.cpu_count(), help="videos rendered in parallel")
    common(b)

    sub.add_parser("list", help="show patterns and scenes")
    a = ap.parse_args()

    if a.cmd == "list":
        for k, v in PATTERNS.items():
            print(f"{k:10s} {v['title']} ({v['sub']}): " + ", ".join(f"{p} {d}s" for p, d in v["phases"]))
        print("scenes:", ", ".join(SCENES))
        return

    if a.cmd == "one":
        render(a.out, a.pattern, a.scene, a.duration, a.brand, a.seed, a.bg, a.music,
               speed=a.speed, preview=a.preview)
        print("wrote", a.out)
        return

    os.makedirs(a.out_dir, exist_ok=True)
    rng = random.Random(a.seed)
    bgs = []
    if a.bg_dir:
        bgs = sorted(os.path.join(a.bg_dir, f) for f in os.listdir(a.bg_dir)
                     if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
    combos = [(p, s) for p in PATTERNS for s in SCENES]
    rng.shuffle(combos)
    rows, tasks = [], []
    for i in range(a.count):
        pat, scn = combos[i % len(combos)]
        bg = bgs[i % len(bgs)] if bgs else None
        name = f"{i + 1:03d}_{pat}_{'img' if bg else scn}.mp4"
        path = os.path.join(a.out_dir, name)
        tasks.append((path, pat, scn, a.duration, a.brand, rng.randrange(1 << 30), bg, a.music, a.speed))
        rows.append({"file": name, "pattern": pat, "scene": "image" if bg else scn,
                     "caption": post_caption(pat, rng, a.cta)})
    from concurrent.futures import ProcessPoolExecutor
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for k, done in enumerate(ex.map(_render_task, tasks), 1):
            print(f"[{k}/{a.count}] {os.path.basename(done)}", flush=True)
    with open(os.path.join(a.out_dir, "captions.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["file", "pattern", "scene", "caption"])
        w.writeheader()
        w.writerows(rows)
    print("done →", a.out_dir)


if __name__ == "__main__":
    sys.exit(main())
