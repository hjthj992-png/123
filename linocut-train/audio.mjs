// Procedural soundtrack: wind, steam chuffs, rail clacks, whistle, drone. Writes out/sound.wav
import fs from 'node:fs';

const SR = 48000, DUR = 21, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function biquad(type, f, q = 0.707) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  let b0, b1, b2; const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; } // bandpass
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const f_ = (x) => { const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  return f_;
}

// how close the train "feels" per shot (gain) and stereo position
const shots = [[0, 4.2, 0.25], [4.2, 8.6, 1.0], [8.6, 12.2, 0.9], [12.2, 15.4, 0.6], [15.4, 21, 0.45]];
const nearness = (t) => { for (const [a, b, g] of shots) if (t < b) return g; return 0.45; };
const tunnel = (t) => smooth(16.0, 17.5, t);

// wind
{
  const bp = biquad('bp', 500, 0.6), bp2 = biquad('bp', 1400, 2.5);
  for (let i = 0; i < N; i++) {
    const t = i / SR, n = rnd();
    const lfo = 0.55 + 0.45 * Math.sin(t * 0.7) * Math.sin(t * 0.31 + 1);
    const v = (bp(n) * 0.5 + bp2(n) * 0.12 * (0.5 + 0.5 * Math.sin(t * 1.9))) * lfo * 0.35;
    L[i] += v; R[i] += v * 0.9;
  }
}
// steam chuffs: 4 per driver revolution (stylised, slower than real)
{
  const bp = biquad('bp', 380, 0.9), lp = biquad('lp', 2200);
  const rate = 4.6;
  for (let i = 0; i < N; i++) {
    const t = i / SR, ph = (t * rate) % 1, k = Math.floor(t * rate);
    const accent = k % 4 === 0 ? 1.0 : 0.72;
    const env = Math.exp(-ph * 7) * accent;
    const muffle = 1 - tunnel(t) * 0.85;
    let v = lp(bp(rnd()) * env * 3.2) * nearness(t) * muffle;
    const pan = t >= 8.6 && t < 12.2 ? (t - 8.6) / 3.6 * 1.6 - 0.8 : 0.1;
    L[i] += v * (1 - pan) * 0.5; R[i] += v * (1 + pan) * 0.5;
  }
}
// rail-joint clacks: a pair per bogie per 12 m joint
{
  const hp = biquad('hp', 900), bp = biquad('bp', 2600, 3);
  const ev = [];
  const speed = 15, joint = 12, axleGaps = [0, 1.3];
  const bogies = [0, 3, 8, 15, 23, 33, 37, 47, 51, 61];
  for (let j = 0; j * joint / speed < DUR + 5; j++) for (const b of bogies) for (const g of axleGaps) ev.push((j * joint + b + g) / speed);
  for (const te of ev) {
    if (te > DUR) continue;
    const i0 = Math.floor(te * SR);
    const g = nearness(te) * (te > 8.6 && te < 12.2 ? 1.6 : 0.8) * (1 - tunnel(te) * 0.9);
    for (let k = 0; k < SR * 0.07 && i0 + k < N; k++) {
      const env = Math.exp(-k / (SR * 0.012));
      const v = (bp(rnd()) * 1.5 + Math.sin(k / SR * 2 * Math.PI * 1900) * 0.3) * env * g * 0.5;
      L[i0 + k] += v; R[i0 + k] += v * 0.85;
    }
  }
  void hp;
}
// whistle: two-tone chord with vibrato, plus a tunnel-echo version
function whistle(t0, dur, gain, echo) {
  const fs_ = [587, 740, 880];
  for (let i = Math.floor(t0 * SR); i < Math.min(N, (t0 + dur) * SR); i++) {
    const t = i / SR - t0;
    const env = smooth(0, 0.08, t) * (1 - smooth(dur - 0.35, dur, t));
    const vib = 1 + Math.sin(t * 2 * Math.PI * 5.5) * 0.006;
    let v = 0; for (const f of fs_) v += Math.sin(2 * Math.PI * f * vib * t) + 0.3 * Math.sin(4 * Math.PI * f * vib * t);
    v += rnd() * 0.25;
    v *= env * gain * 0.09;
    for (const [d, a] of echo) { const j = i + Math.floor(d * SR); if (j < N) { L[j] += v * a; R[j] += v * a * 0.8; } }
    L[i] += v; R[i] += v;
  }
}
whistle(4.35, 1.6, 1.0, [[0.32, 0.35], [0.7, 0.18]]);
whistle(15.5, 1.2, 0.6, [[0.25, 0.5], [0.55, 0.35], [0.95, 0.2]]);
// cinematic drone + low hits on cuts
{
  const chord = [55, 82.4, 110, 164.8];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = smooth(0, 3, t) * (1 - smooth(DUR - 2.5, DUR, t));
    let v = 0; chord.forEach((f, k) => { v += Math.sin(2 * Math.PI * f * t + k) * (1 + 0.3 * Math.sin(t * 0.4 + k)); });
    v *= env * 0.05;
    L[i] += v; R[i] += v;
  }
  for (const tc of [0.05, 4.2, 8.6, 12.2, 15.4]) {
    for (let k = 0; k < SR * 1.2; k++) {
      const i = Math.floor(tc * SR) + k; if (i >= N) break;
      const tt = k / SR;
      const v = Math.sin(2 * Math.PI * (48 - 20 * tt) * tt) * Math.exp(-tt * 4) * 0.35;
      L[i] += v; R[i] += v;
    }
  }
}
// master: fade + soft clip
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, f = smooth(0, 0.4, t) * (1 - smooth(DUR - 1.2, DUR, t));
  L[i] = Math.tanh(L[i] * f * 1.2); R[i] = Math.tanh(R[i] * f * 1.2);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
const g = 0.89 / peak;
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4); }
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./out/sound.wav', import.meta.url), buf);
console.log('wrote out/sound.wav, peak', peak.toFixed(2));
