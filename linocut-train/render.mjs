// Renders the scene frame-by-frame in headless Chromium and pipes PNGs into ffmpeg.
// usage: node render.mjs [--w 2560 --h 1440 --fps 30 --out out/film.mp4]
//        node render.mjs --stills 1,5,9 --w 960 --h 540   (preview frames)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('/opt/node22/lib/node_modules/playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), []));
const W = +(args.w || 2560), H = +(args.h || 1440), FPS = +(args.fps || 30);
const OUT = args.out || 'out/film_raw.mp4';
const root = path.dirname(new URL(import.meta.url).pathname);
fs.mkdirSync(path.join(root, 'out'), { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`http://localhost:${port}/index.html?render&w=${W}&h=${H}`);
await page.waitForFunction('window.ready === true', null, { timeout: 120000 });
const duration = await page.evaluate('window.DURATION');
const canvas = await page.$('canvas');

if (args.stills) {
  for (const t of String(args.stills).split(',').map(Number)) {
    await page.evaluate((t) => window.renderAt(t), t);
    await canvas.screenshot({ path: path.join(root, `out/still_${t}.png`) });
    console.log('still', t);
  }
} else {
  const total = Math.round(duration * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', path.join(root, OUT)], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.renderAt(t), i / FPS);
    const buf = await canvas.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 15 === 0) console.log(`frame ${i}/${total}  ${((Date.now() - t0) / 1000 / (i + 1)).toFixed(2)}s/frame`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('wrote', OUT);
}
await browser.close();
server.close();
