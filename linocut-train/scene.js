// Linocut Express — a procedural woodcut-style train film, 100% code.
// Three.js scene + custom "linocut" material + edge/paper post-processing.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

THREE.ColorManagement.enabled = false;

const qs = new URLSearchParams(location.search);
const RENDER = qs.has('render');
const W = +qs.get('w') || innerWidth;
const H = +qs.get('h') || innerHeight;
const DURATION = 21;

const PAL = {
  paper: new THREE.Color('#efe8d8'),
  ink: new THREE.Color('#131317'),
  red: new THREE.Color('#d3242a'),
  gold: new THREE.Color('#f3b43c'),
};

// ---------------------------------------------------------------- utils
let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rr = (a, b) => a + (b - a) * rnd();
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function vnoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = (a, b) => hash1(a * 57.0 + b * 113.0);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm2 = (x, y) => vnoise2(x, y) * 0.5 + vnoise2(x * 2.03, y * 2.03) * 0.3 + vnoise2(x * 4.1, y * 4.1) * 0.2;

// ---------------------------------------------------------------- shaders
const NOISE_GLSL = /* glsl */`
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x), mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x), mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y), f.z); }
float vnoise2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }
`;

const LINO_VERT = /* glsl */`
varying vec3 vWorld; varying vec3 vLocal;
void main(){
  vec4 lp = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
  #endif
  vLocal = lp.xyz;
  vec4 wp = modelMatrix * lp;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const LINO_FRAG = /* glsl */`
uniform vec3 uLit, uDark, uPaper, uInk, uLightDir;
uniform float uT0, uT1, uMode, uSpeck, uScratch, uSnowY, uHatch;
varying vec3 vWorld; varying vec3 vLocal;
${NOISE_GLSL}
void main(){
  if (uMode > 0.5) {                       // flat "printed" colour (glowing windows, trim)
    if (uMode > 1.5) { float s = fract((vLocal.x + vLocal.z) * 1.7 + vLocal.y * 1.7); if (s > 0.55) discard; }
    gl_FragColor = vec4(uLit, 1.0); return;
  }
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float l = dot(n, normalize(uLightDir)) * 0.5 + 0.5;
  l += (vnoise(vWorld * 0.35) - 0.5) * 0.14;

  // carved hatching: stripe coordinate follows the surface, wobbles like a gouge
  vec3 an = abs(n);
  float coord = an.y > 0.7 ? vLocal.x * 0.8 + vLocal.z * 0.35 : vLocal.y + (vLocal.x + vLocal.z) * 0.25;
  coord = coord * uHatch + vnoise(vLocal * 0.25) * 1.3;
  float k = smoothstep(uT0, uT1, l);
  float inkFrac = 1.0 - k;
  float d = abs(fract(coord) - 0.5) * 2.0;
  float w = fwidth(coord);
  float mask = smoothstep(inkFrac - w * 1.5, inkFrac + w * 1.5, d);
  mask = mix(mask, 1.0 - inkFrac, smoothstep(0.35, 0.9, w));
  if (k > 0.97) mask = 1.0;
  if (k < 0.03) mask = 0.0;
  vec3 col = mix(uDark, uLit, mask);

  // snow settles on upward faces
  float snowEdge = uSnowY + (vnoise(vWorld * 1.3) - 0.5) * 0.12;
  if (n.y > snowEdge) col = uPaper;

  // frost specks on paint
  if (uSpeck > 0.0) {
    vec3 c = vLocal * 9.0; vec3 id = floor(c);
    float h = hash13(id);
    if (h > 1.0 - uSpeck && length(fract(c) - 0.5) < 0.22) col = uPaper;
  }
  // gouge scratches in the snow
  if (uScratch > 0.0) {
    float y = vLocal.z * 0.55 + vnoise2(vLocal.xz * 0.03) * 6.0;
    float line = abs(fract(y) - 0.5);
    float seg = vnoise2(vec2(vLocal.x * 0.06, floor(y) * 3.1));
    float lw = fwidth(y);
    if (line < 0.03 + lw * 0.5 && seg > 0.7 && lw < 0.4) col = mix(col, uInk, 0.85);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const LIGHT_A = V(0.35, 0.6, 0.72).normalize(), LIGHT_B = V(-0.55, 0.62, 0.55).normalize();
const lightDir = LIGHT_A.clone();

function lino(o = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: LINO_VERT,
    fragmentShader: LINO_FRAG,
    uniforms: {
      uLit: { value: (o.lit || PAL.paper).clone() },
      uDark: { value: (o.dark || PAL.ink).clone() },
      uPaper: { value: PAL.paper },
      uInk: { value: PAL.ink },
      uLightDir: { value: lightDir },
      uT0: { value: o.t0 ?? 0.35 },
      uT1: { value: o.t1 ?? 0.65 },
      uMode: { value: o.mode ?? 0 },
      uSpeck: { value: o.speck ?? 0 },
      uScratch: { value: o.scratch ?? 0 },
      uSnowY: { value: o.snowY ?? 2 },
      uHatch: { value: o.hatch ?? 1 },
    },
    side: o.side ?? THREE.FrontSide,
  });
}

const M = {
  snow: lino({ t0: 0.05, t1: 0.42, scratch: 1, hatch: 0.6 }),
  rock: lino({ t0: 0.42, t1: 0.62, snowY: 0.62, hatch: 0.35 }),
  cliff: lino({ t0: 0.55, t1: 0.82, snowY: 0.55, hatch: 0.8 , side: THREE.DoubleSide }),
  tree: lino({ t0: 0.6, t1: 0.95, snowY: 0.7, hatch: 2.2 }),
  red: lino({ lit: PAL.red, t0: 0.28, t1: 0.55, speck: 0.07, snowY: 0.86, hatch: 3.0 }),
  redClean: lino({ lit: PAL.red, t0: 0.25, t1: 0.5, snowY: 0.9, hatch: 4.0 }),
  ink: lino({ t0: 0.78, t1: 1.15, hatch: 4.0, snowY: 0.86 }),
  inkSolid: lino({ lit: PAL.ink, dark: PAL.ink, side: THREE.DoubleSide }),
  gold: lino({ lit: PAL.gold, mode: 1 }),
  glow: lino({ lit: PAL.gold, mode: 2, side: THREE.DoubleSide }),
  smoke: lino({ t0: 0.12, t1: 0.45, hatch: 1.6 }),
  moon: lino({ lit: PAL.paper, mode: 1, side: THREE.DoubleSide }),
};

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.domElement.style.width = RENDER ? W + 'px' : '100vw';
renderer.domElement.style.height = RENDER ? H + 'px' : '100vh';
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = PAL.ink.clone();
const camera = new THREE.PerspectiveCamera(40, W / H, 0.3, 4000);

// ---------------------------------------------------------------- track
const track = new THREE.CatmullRomCurve3(
  [[-460, 300], [-380, 250], [-280, 190], [-170, 120], [-60, 60], [40, 15], [120, -30], [180, -80],
   [225, -125], [265, -165], [305, -205], [345, -245], [400, -300], [460, -360]].map(([x, z]) => V(x, 0, z)),
  false, 'centripetal');
track.arcLengthDivisions = 4000;
const TRACK_LEN = track.getLength();
const P = (d) => track.getPointAt(clamp(d / TRACK_LEN, 0, 1));
const TAN = (d) => track.getTangentAt(clamp(d / TRACK_LEN, 0, 1));
const sideOf = (f) => V(f.z, 0, -f.x); // object-local +x when facing f

const trackSamples = [];
for (let d = 0; d <= TRACK_LEN; d += 3) trackSamples.push(P(d));
function distToTrack(x, z) {
  let m = 1e9;
  for (const p of trackSamples) { const dx = p.x - x, dz = p.z - z; const q = dx * dx + dz * dz; if (q < m) m = q; }
  return Math.sqrt(m);
}
let dPortal = 0;
{ let best = 1e9; for (let d = 0; d < TRACK_LEN; d += 0.25) { const p = P(d); const q = (p.x - 290) ** 2 + (p.z + 190) ** 2; if (q < best) { best = q; dPortal = d; } } }
const portalP = P(dPortal), portalF = TAN(dPortal).setY(0).normalize(), portalR = sideOf(portalF);

// tunnel block footprint test (local coords of the cliff)
const portalYaw = Math.atan2(portalF.x, portalF.z);
function inCliff(x, z, pad = 0) {
  const dx = x - portalP.x, dz = z - portalP.z;
  const lz = dx * portalF.x + dz * portalF.z, lx = dx * portalR.x + dz * portalR.z;
  return lz > -6 - pad && lz < 75 + pad && Math.abs(lx) < 95 + pad;
}

// ---------------------------------------------------------------- terrain
function groundH(x, z, dt = null) {
  const d = dt ?? distToTrack(x, z);
  const hills = (fbm2(x * 0.006, z * 0.006) - 0.35) * 70;
  const dp = Math.hypot(x - portalP.x, z - portalP.z);
  return Math.max(0, hills) * smooth(14, 90, d) * smooth(70, 170, dp) + (fbm2(x * 0.05, z * 0.05) - 0.5) * 1.2 * smooth(6, 20, d);
}
{
  const g = new THREE.PlaneGeometry(2400, 2400, 240, 240);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundH(pos.getX(i), pos.getZ(i)));
  scene.add(new THREE.Mesh(g, M.snow));
}

// rails, sleepers, poles
{
  const pts = [], sl = [], poles = [];
  for (let d = 0; d <= TRACK_LEN; d += 2) pts.push(P(d));
  for (const s of [-0.75, 0.75]) {
    const rp = pts.map((p, i) => { const f = TAN(i * 2); return p.clone().addScaledVector(sideOf(f), s).setY(0.32); });
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rp), pts.length * 2, 0.09, 4), M.ink));
  }
  const sg = new THREE.BoxGeometry(2.7, 0.2, 0.32);
  const inst = new THREE.InstancedMesh(sg, M.ink, Math.ceil(TRACK_LEN / 0.95));
  const o = new THREE.Object3D(); let n = 0;
  for (let d = 0; d < TRACK_LEN; d += 0.95) {
    const p = P(d), f = TAN(d);
    o.position.set(p.x, 0.12, p.z); o.rotation.set(0, Math.atan2(f.x, f.z), 0); o.updateMatrix();
    inst.setMatrixAt(n++, o.matrix);
  }
  inst.count = n; scene.add(inst);

  const pole = mergeGeometries([
    new THREE.CylinderGeometry(0.16, 0.2, 9, 5).translate(0, 4.5, 0),
    new THREE.BoxGeometry(2.2, 0.18, 0.18).translate(0, 8.2, 0),
    new THREE.BoxGeometry(1.6, 0.14, 0.14).translate(0, 7.4, 0),
  ]);
  const pinst = new THREE.InstancedMesh(pole, M.ink, 60); n = 0;
  for (let d = 420; d < dPortal - 20; d += 34) {
    const p = P(d), f = TAN(d), s = sideOf(f);
    o.position.copy(p).addScaledVector(s, -6.5); o.rotation.set(0, Math.atan2(s.x, s.z), (hash1(d) - 0.5) * 0.06); o.updateMatrix();
    pinst.setMatrixAt(n++, o.matrix);
  }
  pinst.count = n; scene.add(pinst);
}

// mountains: faceted jagged cones
function peak(r, h, segs = 11) {
  const g = new THREE.ConeGeometry(r, h, segs, 5, true);
  const p = g.attributes.position;
  const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  const cache = new Map();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = key(x, y, z);
    if (!cache.has(k)) {
      const top = y > h / 2 - 0.01;
      const j = top ? [rr(-0.08, 0.08) * r, rr(-0.05, 0.08) * h, rr(-0.08, 0.08) * r] : [x * rr(-0.22, 0.18), rr(-0.06, 0.06) * h, z * rr(-0.22, 0.18)];
      cache.set(k, j);
    }
    const j = cache.get(k);
    p.setXYZ(i, x + j[0], y + j[1] + h / 2, z + j[2]);
  }
  g.computeVertexNormals();
  return g.toNonIndexed();
}
{
  const geos = [];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rr(-0.05, 0.05);
    const R = rr(620, 1000);
    const r = rr(110, 220), h = rr(170, 360);
    geos.push(peak(r, h).translate(Math.cos(a) * R, -8, Math.sin(a) * R));
    if (rnd() < 0.7) { const R2 = R * rr(0.62, 0.8); geos.push(peak(r * 0.6, h * 0.5, 9).translate(Math.cos(a + 0.06) * R2, -6, Math.sin(a + 0.06) * R2)); }
  }
  // the tunnel mountain massif behind the cliff
  const c = portalP.clone().addScaledVector(portalF, 205);
  geos.push(peak(145, 240, 13).translate(c.x, -10, c.z));
  geos.push(peak(110, 150, 11).translate(c.x + portalR.x * 120, -8, c.z + portalR.z * 120));
  geos.push(peak(100, 130, 11).translate(c.x - portalR.x * 130, -8, c.z - portalR.z * 130));
  scene.add(new THREE.Mesh(mergeGeometries(geos), M.rock));
}

// tunnel cliff: extruded hill silhouette with an arch cut through it
{
  const s = new THREE.Shape();
  const pts = [];
  for (let x = -95; x <= 95; x += 6) {
    const t = x / 95;
    const y = 46 * Math.pow(1 - t * t, 0.75) + (hash1(x * 3.1) - 0.5) * 7 + 14 * Math.exp(-(t * t) * 30);
    pts.push([x, Math.max(y, 3)]);
  }
  s.moveTo(-95, -3); for (const [x, y] of pts) s.lineTo(x, y); s.lineTo(95, -3); s.lineTo(-95, -3);
  const hw = 3.6, hh = 7.0;
  const g = new THREE.ExtrudeGeometry(s, { depth: 70, bevelEnabled: false, curveSegments: 18 });
  g.computeVertexNormals();
  const cliff = new THREE.Mesh(g, [M.cliff, M.cliff]);
  cliff.position.copy(portalP).setY(0);
  cliff.rotation.y = portalYaw;
  scene.add(cliff);
  // the tunnel mouth: a black arch just in front of the rock face — the train dives into it
  const inside = new THREE.Group();
  const arch = new THREE.Shape();
  arch.moveTo(-hw, -0.5); arch.lineTo(hw, -0.5); arch.lineTo(hw, hh); arch.absarc(0, hh, hw, 0, Math.PI, false); arch.lineTo(-hw, -0.5);
  inside.add(new THREE.Mesh(new THREE.ShapeGeometry(arch, 24).translate(0, 0, -0.08), M.inkSolid));
  // stone ring around the portal
  const ring = new THREE.TorusGeometry(hw + 0.55, 0.6, 5, 18, Math.PI).translate(0, hh, -0.3);
  const legs = [-1, 1].map((sx) => new THREE.BoxGeometry(1.2, hh + 3, 1.3).translate(sx * (hw + 0.55), (hh - 3) / 2, -0.3));
  const keystone = new THREE.BoxGeometry(1.4, 1.6, 1.5).translate(0, hh + hw + 0.5, -0.4);
  inside.add(new THREE.Mesh(mergeGeometries([ring, ...legs, keystone]), M.ink));
  inside.position.copy(cliff.position); inside.rotation.y = portalYaw;
  scene.add(inside);
  const rocks = [];
  for (let i = 0; i < 70; i++) {
    const x = rr(-90, 90), y = rr(-2, 34) * Math.pow(1 - Math.abs(x) / 95, 0.6);
    if (Math.abs(x) < hw + 4 && y < hh + hw + 5) continue;
    const r = rr(2.5, 7);
    rocks.push(new THREE.DodecahedronGeometry(r, 0).scale(1, rr(0.6, 1.1), 0.7).rotateY(rr(0, 6)).rotateX(rr(-0.4, 0.4)).translate(x, y, rr(-2, 1)));
  }
  const rm = new THREE.Mesh(mergeGeometries(rocks), M.cliff);
  rm.position.copy(cliff.position); rm.rotation.y = portalYaw; scene.add(rm);
}

// forests: stacked-cone pines
{
  const parts = [];
  parts.push(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 5).translate(0, 1.1, 0));
  for (let i = 0; i < 4; i++) {
    const r = 2.6 - i * 0.55, h = 3.0 - i * 0.35;
    parts.push(new THREE.ConeGeometry(r, h, 7, 1).translate(0, 2.2 + i * 1.75 + h / 2, 0));
  }
  const tg = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  const N = 3600;
  const inst = new THREE.InstancedMesh(tg, M.tree, N);
  const o = new THREE.Object3D(); let n = 0, tries = 0;
  while (n < N && tries++ < 200000) {
    const x = rr(-650, 750), z = rr(-650, 650);
    const dt = distToTrack(x, z);
    if (dt < 11 || inCliff(x, z, 4)) continue;
    const dens = fbm2(x * 0.012 + 40, z * 0.012 - 13);
    if (dens < 0.5 && !(dt < 60 && rnd() < 0.08)) continue;
    const s = rr(0.7, 1.9) * (dt < 40 ? 1.15 : 1);
    o.position.set(x, groundH(x, z, dt) - 0.3, z); o.rotation.set(rr(-0.04, 0.04), rr(0, 6.28), rr(-0.04, 0.04));
    o.scale.set(s, s * rr(0.9, 1.25), s); o.updateMatrix();
    inst.setMatrixAt(n++, o.matrix);
  }
  inst.count = n; scene.add(inst);
}

// moon with carved halo rings
const moon = new THREE.Group();
moon.add(new THREE.Mesh(new THREE.CircleGeometry(22, 40), M.moon));
for (const r of [30, 37, 45]) moon.add(new THREE.Mesh(new THREE.RingGeometry(r, r + 1.2, 64), M.moon));
scene.add(moon);

// ---------------------------------------------------------------- train
function wheel(r, discMat) {
  const g = new THREE.Group();
  const inkParts = [];
  const rim = new THREE.TorusGeometry(r * 0.94, 0.06 + r * 0.06, 5, 26); rim.rotateY(Math.PI / 2); inkParts.push(rim);
  const spokes = r > 0.7 ? 12 : 6;
  for (let i = 0; i < spokes / 2; i++) {
    for (const sx of [-0.075, 0.075]) inkParts.push(new THREE.BoxGeometry(0.05, r * 1.78, 0.07).rotateX((i / (spokes / 2)) * Math.PI).translate(sx, 0, 0));
  }
  inkParts.push(new THREE.CylinderGeometry(r * 0.2, r * 0.2, 0.26, 8).rotateZ(Math.PI / 2));
  if (r > 0.7) inkParts.push(new THREE.BoxGeometry(0.2, r * 0.36, r * 0.55).translate(0, -r * 0.5, 0)); // counterweight
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, 0.12, 22).rotateZ(Math.PI / 2), discMat));
  g.add(new THREE.Mesh(mergeGeometries(inkParts.map((x) => x.index ? x.toNonIndexed() : x)), M.ink));
  return g;
}
const box = (w, h, l, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat); m.position.set(x, y, z); return m; };
const cylZ = (r1, r2, l, x, y, z, mat, seg = 20) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, l, seg).rotateX(Math.PI / 2), mat); m.position.set(x, y, z); return m; };

function shadowPlate(w, l) { return box(w, 0.02, l, 0, 0.05, 0, M.inkSolid); }

const wheels = []; // {g, r}
function addWheels(car, r, zs, x = 1.08, mat = M.ink) {
  for (const z of zs) for (const sx of [-1, 1]) {
    const w = wheel(r, mat); w.position.set(sx * x, r + 0.3, z); car.add(w); wheels.push({ g: w, r });
  }
}

const cars = [];
// locomotive
const loco = new THREE.Group();
{
  const DR = 0.95, AY = DR + 0.3;
  loco.add(box(1.5, 0.8, 12.5, 0, 1.45, 0.2, M.ink));                     // frame
  loco.add(box(3.1, 0.14, 9.6, 0, 2.28, 1.4, M.ink));                     // running board
  loco.add(box(0.1, 0.3, 9.6, 1.55, 2.12, 1.4, M.red));                   // valance
  loco.add(box(0.1, 0.3, 9.6, -1.55, 2.12, 1.4, M.red));
  loco.add(cylZ(1.15, 1.15, 7.9, 0, 3.15, 1.35, M.red, 28));              // boiler
  for (const z of [-1.6, 1.3, 4.3]) loco.add(cylZ(1.19, 1.19, 0.14, 0, 3.15, z, M.gold, 28));
  loco.add(cylZ(1.24, 1.24, 1.5, 0, 3.15, 6.0, M.ink, 28));               // smokebox
  loco.add(cylZ(0.95, 0.95, 0.12, 0, 3.15, 6.78, M.ink, 28));             // door
  loco.add(cylZ(0.32, 0.32, 0.1, 0, 3.15, 6.86, M.gold, 16));             // number disc
  const chim = new THREE.Mesh(mergeGeometries([
    new THREE.CylinderGeometry(0.42, 0.34, 1.4, 14).translate(0, 0.7, 0),
    new THREE.CylinderGeometry(0.62, 0.45, 0.35, 14).translate(0, 1.5, 0)]), M.ink);
  chim.position.set(0, 4.15, 6.0); loco.add(chim);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.red); dome.scale.set(1, 1.15, 1.2); dome.position.set(0, 4.15, 2.6); loco.add(dome);
  const dome2 = dome.clone(); dome2.scale.set(0.8, 0.9, 0.9); dome2.position.set(0, 4.15, 0.2); loco.add(dome2);
  loco.add(cylZ(0.1, 0.1, 0.5, 0, 4.9, 2.6, M.gold, 8));                  // whistle-ish
  // cab
  loco.add(box(3.0, 3.2, 3.3, 0, 3.9, -4.15, M.red));
  loco.add(box(3.4, 0.22, 4.0, 0, 5.6, -4.2, M.ink));
  for (const sx of [-1, 1]) {
    loco.add(box(0.04, 1.0, 1.0, sx * 1.52, 4.45, -3.8, M.gold));
    loco.add(box(0.05, 1.2, 1.2, sx * 1.51, 4.45, -3.8, M.ink));
    loco.add(box(0.05, 0.12, 3.3, sx * 1.52, 3.0, -4.15, M.gold));
  }
  for (const sx of [-0.8, 0.8]) loco.add(box(0.55, 0.6, 0.05, sx, 4.75, -2.48, M.gold));
  // front end
  loco.add(box(3.1, 0.7, 0.35, 0, 1.6, 7.0, M.red));
  for (const sx of [-1.05, 1.05]) loco.add(cylZ(0.2, 0.2, 0.5, sx, 1.6, 7.35, M.ink, 10));
  const cc = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.3, 0.16), M.ink); cc.position.set(0, 0.85, 7.45); cc.rotation.x = -0.6; loco.add(cc);
  loco.add(box(0.7, 0.7, 0.7, 0, 4.55, 6.35, M.ink));                     // headlamp
  loco.add(cylZ(0.27, 0.27, 0.06, 0, 4.55, 6.72, M.gold, 16));
  // cylinders + motion
  for (const sx of [-1, 1]) loco.add(cylZ(0.45, 0.45, 1.5, sx * 1.62, AY + 0.05, 3.1, M.red, 16));
  addWheels(loco, DR, [1.4, -0.6, -2.6], 1.12, M.red);
  addWheels(loco, 0.5, [5.2, 4.2], 1.0, M.ink);
  loco.userData.rods = [-1, 1].map((sx) => {
    const coupling = box(0.12, 0.2, 4.5, sx * 1.33, 0, -0.6, M.ink);
    const main = box(0.12, 0.22, 3.0, sx * 1.42, 0, 0, M.ink);
    const xhead = box(0.2, 0.35, 0.5, sx * 1.42, AY + 0.05, 0, M.ink);
    loco.add(coupling, main, xhead);
    return { sx, coupling, main, xhead };
  });
  loco.userData.AY = AY; loco.userData.DR = DR;
  loco.add(shadowPlate(3.6, 14));
  cars.push({ g: loco, len: 14.5 });
}
// tender
{
  const t = new THREE.Group();
  t.add(box(3.0, 2.6, 6.8, 0, 2.65, 0, M.red));
  t.add(box(3.06, 0.14, 6.86, 0, 2.0, 0, M.gold));
  const coal = new THREE.Mesh(peak(1.6, 1.2, 7), M.ink); coal.scale.set(0.9, 0.8, 1.8); coal.position.set(0, 3.7, 0.4); t.add(coal);
  t.add(box(2.2, 0.6, 6.2, 0, 1.2, 0, M.ink));
  addWheels(t, 0.55, [-2.5, -1.4, 1.4, 2.5]);
  t.add(shadowPlate(3.6, 7.4));
  cars.push({ g: t, len: 7.6 });
}
// coaches
const SIL = mergeGeometries([new THREE.CircleGeometry(0.17, 12).translate(0, 0.2, 0), new THREE.CircleGeometry(0.3, 12, 0, Math.PI).translate(0, -0.22, 0)]);
for (let c = 0; c < 3; c++) {
  const g = new THREE.Group();
  g.add(box(2.95, 2.9, 13.6, 0, 2.85, 0, M.red));
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 14.0, 24, 1, false, -0.68, 1.36).rotateX(Math.PI / 2).rotateZ(0), M.ink);
  roof.position.set(0, 2.55, 0); g.add(roof);
  g.add(box(3.0, 0.13, 13.6, 0, 2.15, 0, M.gold));
  g.add(box(2.3, 0.6, 12.2, 0, 1.15, 0, M.ink));
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = -4.6 + i * 1.84;
      g.add(box(0.04, 0.95, 1.1, sx * 1.505, 3.25, z, M.gold));
      g.add(box(0.05, 1.15, 1.3, sx * 1.485, 3.25, z, M.ink));
      if (hash1(c * 31 + i * 7 + sx) > 0.62) {
        const s = new THREE.Mesh(SIL, M.inkSolid); s.position.set(sx * 1.535, 3.12, z + (hash1(i + c) - 0.5) * 0.3); s.rotation.y = sx * Math.PI / 2; g.add(s);
      }
      const pool = box(1.6, 0.02, 1.0, sx * 3.1, 0.06, z + sx * 0.0, M.glow); // window light on the snow
      g.add(pool);
    }
    for (const z of [-6.35, 6.35]) g.add(box(0.06, 2.3, 0.85, sx * 1.48, 2.65, z, M.ink));
  }
  for (const z of [-7.0, 7.0]) g.add(box(2.0, 2.6, 0.4, 0, 2.8, z, M.ink)); // gangways
  addWheels(g, 0.5, [-5.3, -4.0, 4.0, 5.3]);
  g.add(shadowPlate(3.6, 14));
  cars.push({ g, len: 14.4 });
}
for (const c of cars) scene.add(c.g);

const SPEED = 15;
const TUNNEL_T = 16.0;
const headAt = (t) => dPortal + SPEED * (t - TUNNEL_T);

function placeCar(g, dFront, len) {
  const pf = P(dFront - 0.6), pr = P(dFront - len + 0.6);
  g.position.copy(pf).add(pr).multiplyScalar(0.5);
  g.lookAt(pf);
}
function placeTrain(t) {
  let d = headAt(t);
  for (const c of cars) { placeCar(c.g, d, c.len); d -= c.len; }
  const h = headAt(t);
  for (const w of wheels) w.g.rotation.x = h / w.r;
  const { AY, DR } = loco.userData, RC = 0.42;
  for (const r of loco.userData.rods) {
    const a = h / DR + (r.sx > 0 ? Math.PI / 2 : 0);
    const py = AY + RC * Math.cos(a), pz = RC * Math.sin(a);
    r.coupling.position.set(r.sx * 1.33, py, -0.6 + pz);
    const pin = V(0, py, -0.6 + pz);
    const L = 3.0, dy = AY + 0.05 - pin.y;
    const xz = pin.z + Math.sqrt(L * L - dy * dy);
    r.xhead.position.z = xz;
    r.main.position.set(r.sx * 1.42, (pin.y + AY + 0.05) / 2, (pin.z + xz) / 2);
    r.main.rotation.x = -Math.atan2(dy, xz - pin.z);
  }
}

// ---------------------------------------------------------------- smoke
const tmpObj = new THREE.Object3D();
function chimneyAt(t) {
  placeCar(tmpObj, headAt(t), cars[0].len);
  tmpObj.updateMatrixWorld();
  return tmpObj.localToWorld(V(0, 6.0, 6.0));
}
const puffGeo = new THREE.IcosahedronGeometry(1, 1);
const PUFFS = 120;
const puffs = new THREE.InstancedMesh(puffGeo, M.smoke, PUFFS);
puffs.frustumCulled = false; scene.add(puffs);
const spiralGeo = (() => {
  const pts = []; for (let a = 0; a < Math.PI * 4.2; a += 0.12) { const r = 0.15 + a * 0.085; pts.push(V(Math.cos(a) * r, Math.sin(a) * r, 0)); }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, 0.06, 4);
})();
const spirals = new THREE.InstancedMesh(spiralGeo, M.moon, PUFFS);
spirals.frustumCulled = false; scene.add(spirals);

const SMOKE_DT = 0.055, LIFE = 4.2;
function updateSmoke(t) {
  let n = 0, ns = 0;
  const k0 = Math.ceil((t - LIFE) / SMOKE_DT), k1 = Math.floor(t / SMOKE_DT);
  const q = new THREE.Quaternion(), roll = new THREE.Quaternion();
  for (let k = k0; k <= k1 && n < PUFFS; k++) {
    const te = k * SMOKE_DT, age = t - te;
    if (headAt(te) > dPortal - 5) continue;
    const base = chimneyAt(te);
    const h1 = hash1(k * 1.7), h2 = hash1(k * 3.3 + 1), h3 = hash1(k * 5.9 + 2);
    const rise = age * 3.2 + Math.sqrt(age) * 2.0;
    const pos = base.add(V((h1 - 0.5) * age * 2.2 - age * 1.1, rise, (h2 - 0.5) * age * 2.2 + age * 0.6));
    const grow = Math.min(1, age * 3.0);
    const fade = 1 - smooth(LIFE - 1.2, LIFE, age);
    const s = (0.45 + age * 0.85 + h3 * 0.5) * grow * fade;
    if (s < 0.01) continue;
    tmpObj.position.copy(pos); tmpObj.quaternion.setFromEuler(new THREE.Euler(h1 * 6, h2 * 6, h3 * 6)); tmpObj.scale.set(s, s * 0.85, s);
    tmpObj.updateMatrix(); puffs.setMatrixAt(n++, tmpObj.matrix);
    if (k % 3 === 0 && ns < PUFFS) {
      roll.setFromAxisAngle(V(0, 0, 1), age * 1.8 * (h1 > 0.5 ? 1 : -1) + h2 * 6);
      q.copy(camera.quaternion).multiply(roll);
      tmpObj.position.copy(pos).add(V((h2 - 0.5) * s * 2.2, s * 0.6, (h1 - 0.5) * s * 2.2));
      tmpObj.quaternion.copy(q); const ss = s * 1.05; tmpObj.scale.set(ss, ss, ss);
      tmpObj.updateMatrix(); spirals.setMatrixAt(ns++, tmpObj.matrix);
    }
  }
  puffs.count = n; spirals.count = ns;
  puffs.instanceMatrix.needsUpdate = true; spirals.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- snowfall
const SNOW_N = 32000, BOX = 90;
const snowMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uCam: { value: V() }, uScale: { value: H }, uPaper: { value: PAL.paper } },
  vertexShader: /* glsl */`
    attribute float aSize; attribute float aSeed;
    uniform float uTime; uniform vec3 uCam; uniform float uScale;
    void main(){
      vec3 p = position + vec3(-3.4, -2.4, 1.3) * uTime * (0.6 + aSeed * 0.8);
      p.x += sin(uTime * 1.3 + aSeed * 40.0) * 0.7;
      p = mod(p - uCam + ${BOX / 2}.0, ${BOX}.0) - ${BOX / 2}.0 + uCam;
      vec4 mv = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(aSize * uScale / -mv.z, 1.2, uScale * 0.014);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uPaper;
    void main(){ if (length(gl_PointCoord - 0.5) > 0.5) discard; gl_FragColor = vec4(uPaper, 1.0); }`,
  depthWrite: false,
});
const snow = (() => {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(SNOW_N * 3), s = new Float32Array(SNOW_N), e = new Float32Array(SNOW_N);
  for (let i = 0; i < SNOW_N; i++) { p[i * 3] = rr(0, BOX); p[i * 3 + 1] = rr(0, BOX); p[i * 3 + 2] = rr(0, BOX); s[i] = rr(0.06, 0.16); e[i] = rnd(); }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(s, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(e, 1));
  const pts = new THREE.Points(g, snowMat); pts.frustumCulled = false; return pts;
})();
scene.add(snow);

// ---------------------------------------------------------------- post
const rtColor = new THREE.WebGLRenderTarget(W, H, { depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
const rtNormal = new THREE.WebGLRenderTarget(W, H);
const normalMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    varying vec3 vView;
    void main(){
      vec4 lp = vec4(position, 1.0);
      #ifdef USE_INSTANCING
        lp = instanceMatrix * lp;
      #endif
      vec4 mv = modelViewMatrix * lp; vView = mv.xyz; gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vView;
    void main(){ vec3 n = normalize(cross(dFdx(vView), dFdy(vView))); gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }`,
  side: THREE.DoubleSide,
});

const postMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: rtColor.texture }, tDepth: { value: rtColor.depthTexture }, tNormal: { value: rtNormal.texture },
    uRes: { value: new THREE.Vector2(W, H) }, uNear: { value: 0.3 }, uFar: { value: 4000 },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uPaper: { value: PAL.paper }, uInk: { value: PAL.ink }, uFade: { value: 1 }, uTime: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tColor, tDepth, tNormal;
    uniform vec2 uRes; uniform float uNear, uFar, uFade, uTime;
    uniform mat4 uInvProj, uCamWorld; uniform vec3 uPaper, uInk;
    varying vec2 vUv;
    ${NOISE_GLSL}
    float invZ(vec2 uv){ float z = texture2D(tDepth, uv).x; float lin = (uNear*uFar)/(uFar - z*(uFar-uNear)); return 1.0/lin; }
    vec3 nrm(vec2 uv){ return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    void main(){
      float s = uRes.y / 1080.0;
      vec2 px = 1.0 / uRes;
      vec2 jit = (vec2(vnoise2(vUv*vec2(160.0,90.0)), vnoise2(vUv*vec2(90.0,160.0)+7.0)) - 0.5) * px * 2.0 * s;
      vec2 uv = vUv + jit;
      float rawZ = texture2D(tDepth, vUv).x;
      bool sky = rawZ >= 0.99999;

      // edges: laplacian of 1/z (flat on planes) + normal discontinuities
      vec2 o = px * 1.4 * s;
      float ic = invZ(uv), il = invZ(uv - vec2(o.x,0.)), ir = invZ(uv + vec2(o.x,0.)), id = invZ(uv - vec2(0.,o.y)), iu = invZ(uv + vec2(0.,o.y));
      float lap = (abs(il + ir - 2.0*ic) + abs(iu + id - 2.0*ic)) / max(ic, 1e-6);
      float dEdge = smoothstep(0.012, 0.03, lap);
      vec3 nc = nrm(uv);
      float nd = 0.0;
      nd += 1.0 - dot(nc, nrm(uv - vec2(o.x,0.))); nd += 1.0 - dot(nc, nrm(uv + vec2(o.x,0.)));
      nd += 1.0 - dot(nc, nrm(uv - vec2(0.,o.y))); nd += 1.0 - dot(nc, nrm(uv + vec2(0.,o.y)));
      float nEdge = smoothstep(0.35, 0.6, nd);
      float edge = max(dEdge, nEdge);
      if (sky) edge = 0.0;
      // far geometry gets thinner, broken lines (like worn carving)
      float far = smoothstep(0.004, 0.0012, ic);
      edge *= 1.0 - far * 0.55 * step(0.5, vnoise2(vUv * uRes / (14.0 * s)));

      vec3 col = texture2D(tColor, vUv).rgb;
      if (sky) {
        vec4 v = uInvProj * vec4(vUv*2.0-1.0, 1.0, 1.0); v /= v.w;
        vec3 dir = normalize((uCamWorld * vec4(v.xyz, 0.0)).xyz);
        float az = atan(dir.z, dir.x), el = asin(clamp(dir.y, -1.0, 1.0));
        float y = el * 70.0 + sin(az * 9.0 + el * 14.0) * 0.8 + vnoise2(vec2(az * 4.0, el * 9.0)) * 3.0;
        float f = abs(fract(y) - 0.5);
        float seg = vnoise2(vec2(az * 22.0 + floor(y) * 3.7, floor(y) * 1.3));
        float lw = fwidth(y);
        float streak = (1.0 - smoothstep(0.025, 0.025 + lw * 1.2, f)) * smoothstep(0.58, 0.68, seg) * (0.55 + 0.45 * smoothstep(0.5, 0.0, el));
        col = mix(uInk, uPaper, streak * 0.8);
        vec2 sg = vec2(az, el) * 160.0; vec2 cell = floor(sg); float h = hash12(cell);
        vec2 fp = fract(sg) - 0.5 - (vec2(hash12(cell + 7.0), hash12(cell + 3.0)) - 0.5) * 0.5;
        float star = step(0.982, h) * (1.0 - smoothstep(0.06, 0.13 + (h - 0.982) * 6.0, length(fp)));
        col = mix(col, uPaper, star * smoothstep(0.02, 0.15, el));
      }
      col = mix(col, uInk, edge);

      // paper + ink texture
      vec2 g = vUv * uRes / s;
      float grain = vnoise2(g / 2.5) * 0.55 + vnoise2(g / 9.0) * 0.45;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col *= mix(1.0, 0.9 + 0.1 * grain, smoothstep(0.2, 0.8, lum));
      col = mix(col, uPaper * 0.32, step(0.86, grain) * (1.0 - smoothstep(0.1, 0.3, lum)) * 0.35);
      float vig = smoothstep(1.25, 0.45, length((vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0)));
      col *= mix(0.78, 1.0, vig);
      col = mix(uInk, col, uFade);
      gl_FragColor = vec4(col, 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

// ---------------------------------------------------------------- shots
const shake = (t, amp) => V(Math.sin(t * 7.1) + Math.sin(t * 13.7) * 0.5, Math.sin(t * 9.3) + Math.sin(t * 17.1) * 0.4, Math.sin(t * 5.3)).multiplyScalar(amp);
const tmpTarget = V();
const SHOTS = [
  { end: 4.2, fov: 34, cam(t) { // establishing: the train crosses the valley
    const d = headAt(2) - 30, p = P(d), f = TAN(d), s = sideOf(f);
    const pos = p.clone().addScaledVector(f, 110).addScaledVector(s, 150).addScaledVector(f, -t * 4);
    pos.y = groundH(pos.x, pos.z) + 26 + t * 1.2;
    tmpTarget.copy(P(headAt(t) - 25)).add(V(0, 30, 0)).addScaledVector(s, -60);
    return [pos, tmpTarget];
  } },
  { end: 8.6, fov: 42, light: LIGHT_B, cam(t) { // locomotive close-up, tracking
    const u = (t - 4.2) / 4.4;
    const pos = cars[0].g.localToWorld(V(6.8 + u * 0.8, 1.6 + u * 0.6, 17 - u * 9)).add(shake(t, 0.05));
    tmpTarget.copy(cars[0].g.localToWorld(V(0, 3.6, 2.5 - u * 2)));
    return [pos, tmpTarget];
  } },
  { end: 12.2, fov: 38, light: LIGHT_B, cam(t) { // trackside, coaches thunder past
    const u = (t - 8.6) / 3.6;
    const dC = headAt(8.6) + 24, p = P(dC), f = TAN(dC), s = sideOf(f);
    const pos = p.clone().addScaledVector(s, -7.2).add(V(0, 1.5, 0)).add(shake(t, 0.03));
    tmpTarget.copy(P(dC - 9 + u * 5)).addScaledVector(s, 0).add(V(0, 2.9, 0));
    return [pos, tmpTarget];
  } },
  { end: 15.4, fov: 40, cam(t) { // high chase toward the mountain
    const u = (t - 12.2) / 3.2;
    const last = cars[cars.length - 1].g;
    const pos = last.localToWorld(V(-9 + u * 2, 6.5 - u * 1.0, -24 + u * 5));
    tmpTarget.copy(cars[0].g.position).add(V(0, 3, 0)).lerp(portalP.clone().add(V(0, 26, 0)), 0.45);
    return [pos, tmpTarget];
  } },
  { end: DURATION, fov: 30, cam(t) { // the tunnel swallows the train
    const u = (t - 15.4) / (DURATION - 15.4);
    const pos = portalP.clone().addScaledVector(portalF, -95 + u * 12).addScaledVector(portalR, -34 + u * 4).add(V(0, 11 - u * 2, 0));
    tmpTarget.copy(portalP).addScaledVector(portalF, -14).add(V(0, 16, 0));
    return [pos, tmpTarget];
  } },
];

// moon sits in the sky of the opening shot
const moonDir = (() => { placeTrain(2); const [p, t] = SHOTS[0].cam(2); const f = t.clone().sub(p).setY(0).normalize(); f.applyAxisAngle(V(0, 1, 0), 0.32); return f.add(V(0, 0.42, 0)).normalize(); })();

function setCamera(t) {
  const shot = SHOTS.find((s) => t < s.end) || SHOTS[SHOTS.length - 1];
  let [pos, target] = shot.cam(t);
  if (window.debugCam) { pos = V(...window.debugCam[0]); target = V(...window.debugCam[1]); }
  camera.position.copy(pos);
  camera.fov = shot.fov;
  lightDir.copy(shot.light || LIGHT_A);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

function renderAt(t) {
  placeTrain(t);
  setCamera(t);
  updateSmoke(t);
  moon.position.copy(camera.position).addScaledVector(moonDir, 1800);
  moon.lookAt(camera.position);
  snowMat.uniforms.uTime.value = t;
  snowMat.uniforms.uCam.value.copy(camera.position);

  snow.visible = false;
  scene.overrideMaterial = normalMat;
  renderer.setRenderTarget(rtNormal); renderer.setClearColor(0x8080ff, 1); renderer.clear(); renderer.render(scene, camera);
  scene.overrideMaterial = null; snow.visible = true;
  renderer.setRenderTarget(rtColor); renderer.render(scene, camera);

  const pu = postMat.uniforms;
  pu.uInvProj.value.copy(camera.projectionMatrixInverse);
  pu.uCamWorld.value.copy(camera.matrixWorld);
  pu.uFade.value = smooth(0, 0.6, t) * (1 - smooth(DURATION - 1.0, DURATION, t));
  pu.uTime.value = t;
  renderer.setRenderTarget(null); renderer.render(postScene, postCam);
}

window.renderAt = (t) => { renderAt(t); renderer.getContext().finish(); return true; };
window.DURATION = DURATION;
window.ready = true;

if (!RENDER) {
  const t0 = performance.now();
  const loop = () => { renderAt(((performance.now() - t0) / 1000) % DURATION); requestAnimationFrame(loop); };
  loop();
}
