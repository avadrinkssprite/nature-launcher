// Pixel-art dusk ocean, rendered at low resolution and upscaled with nearest-neighbour.
(() => {
  const H = 180;
  const canvas = document.getElementById('bg');
  const ctx = canvas.getContext('2d');
  let W, HZ, img, px;

  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return (255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >> 16); };
  const pal = a => a.map(rgb);
  const SKY = pal(['#13244a', '#172b55', '#1b3260', '#1f396b', '#244277', '#2a4b82', '#32558b', '#3f5f92', '#566a96', '#7a7896', '#a88590', '#d39a86', '#eab08a']);
  const CLOUD = pal(['#355486', '#575f8e', '#7f6c8c', '#ac7e86', '#d29383', '#eaab89', '#f8c79c', '#ffdcb0']);
  const SEA = pal(['#5d7aa6', '#4a6a9a', '#3b5d8e', '#305283', '#284877', '#213f6b', '#1b365f', '#162d52']);
  const SEA_HI = rgb('#7f9cc4'), SEA_LO = rgb('#122646'), GLINT = rgb('#ffd6a6'), GLINT2 = rgb('#f2a882');
  const SUN = rgb('#ffe0b0'), SUN_RIM = rgb('#f8bc8c'), LAND = rgb('#18264a'), LAND2 = rgb('#1f2f57');
  const STAR = rgb('#cfd8ff'), BIRD = rgb('#1a2546'), LAMP = rgb('#fff1c4');
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const dither = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

  function hash(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // value noise, periodic in x with period p (so the cloud strip wraps seamlessly)
  function noise(x, y, p) {
    const xi = Math.floor(x), yi = Math.floor(y), u = x - xi, v = y - yi;
    const sx = u * u * (3 - 2 * u), sy = v * v * (3 - 2 * v);
    const x0 = ((xi % p) + p) % p, x1 = (x0 + 1) % p;
    const a = hash(x0, yi), b = hash(x1, yi), c = hash(x0, yi + 1), d = hash(x1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  // precomputed cloud density strip, scrolled horizontally
  const CW = 1024, CH = 120;
  const cloud = new Float32Array(CW * CH);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const n = 0.5 * noise(x / 64, y / 26, CW / 64) + 0.3 * noise(x / 26, y / 11, Math.round(CW / 26)) + 0.2 * noise(x / 10, y / 5, Math.round(CW / 10));
    const band = Math.exp(-((y - 46) ** 2) / 900); // clouds live mid-sky
    cloud[y * CW + x] = n * band - 0.41;
  }
  const cloudAt = (x, y) => (y < 0 || y >= CH ? -1 : cloud[y * CW + (((x % CW) + CW) % CW)]);

  const stars = Array.from({ length: 40 }, (_, i) => [hash(i, 1), hash(i, 2), hash(i, 3)]);
  const birds = Array.from({ length: 4 }, (_, i) => ({ x: hash(i, 9), y: 30 + hash(i, 7) * 40, s: 3 + hash(i, 5) * 4, ph: hash(i, 4) * 10 }));

  function resize() {
    W = Math.max(200, Math.round(H * innerWidth / innerHeight));
    HZ = Math.round(H * 0.66);
    canvas.width = W; canvas.height = H;
    img = ctx.createImageData(W, H);
    px = new Uint32Array(img.data.buffer);
  }

  function draw(t) {
    const sunX = Math.round(W * 0.7), sunY = HZ - 7, sunR = 11;
    const scroll = Math.floor(t * 1.5);
    const isle0 = Math.round(W * 0.14), isleW = 46;

    for (let y = 0; y < HZ; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        // sky gradient, dithered into palette bands
        const g = Math.pow(y / HZ, 1.25) * (SKY.length - 1) + dither(x, y) - 0.5;
        let c = SKY[Math.max(0, Math.min(SKY.length - 1, Math.round(g)))];
        const dx = x - sunX, dy = y - sunY, r2 = dx * dx + dy * dy;
        if (r2 < sunR * sunR) c = r2 < (sunR - 2) ** 2 ? SUN : SUN_RIM;
        const cx = x + scroll, d = cloudAt(cx, y);
        if (d > 0) {
          // lit from below by the low sun: undersides glow, upper bodies fade into blue-violet
          const under = d - cloudAt(cx, y + 3), warm = 1 - Math.abs(x - sunX) / W;
          const l = 1.2 + d * 9 + under * 22 + warm * 2.2 + (y / HZ) * 2 + dither(x, y) - 0.5;
          c = CLOUD[Math.max(0, Math.min(CLOUD.length - 1, Math.floor(l)))];
        }
        px[row + x] = c;
      }
    }

    for (const [sx, sy, ph] of stars) {
      const x = Math.floor(sx * W), y = Math.floor(sy * HZ * 0.4);
      if (cloudAt(x + scroll, y) <= 0 && Math.sin(t * 2 + ph * 40) > -0.3) px[y * W + x] = STAR;
    }

    // island with lighthouse
    for (let i = 0; i < isleW; i++) {
      const u = i / isleW, hgt = Math.round(9 * Math.sin(Math.PI * u) ** 0.6 + 3 * Math.sin(u * 13) * Math.sin(Math.PI * u));
      for (let k = 0; k < hgt; k++) px[(HZ - 1 - k) * W + isle0 + i] = k > hgt - 2 ? LAND2 : LAND;
    }
    const lx = isle0 + 30, ltop = HZ - 24;
    for (let y = ltop; y < HZ - 8; y++) for (let x = lx - 1; x <= lx + 1; x++) px[y * W + x] = (y - ltop) % 5 < 2 && y > ltop + 2 ? LAND2 : LAND;
    if (Math.floor(t * 1.2) % 3 !== 0) px[(ltop + 1) * W + lx] = LAMP;

    // ocean
    for (let y = HZ; y < H; y++) {
      const depth = (y - HZ) / (H - HZ), row = y * W;
      const fx = 0.5 / (1 + depth * 6), fy = 1.4 / (1 + depth * 3), drift = t * (2 + depth * 10);
      const glintW = 4 + depth * 46;
      for (let x = 0; x < W; x++) {
        const g = Math.pow(depth, 0.7) * (SEA.length - 1) + dither(x, y) - 0.5;
        let c = SEA[Math.max(0, Math.min(SEA.length - 1, Math.round(g)))];
        const w = noise((x + drift) * fx, y * fy + t * 0.6, 4096);
        if (w > 0.74) c = SEA_HI; else if (w < 0.2) c = SEA_LO;
        const gx = Math.abs(x - sunX);
        if (gx < glintW) {
          const s = noise(x * fx * 2 - t * 3, y * fy * 1.3 + t, 4096) * (1 - gx / glintW);
          if (s > 0.38) c = s > 0.52 ? GLINT : GLINT2;
        }
        px[row + x] = c;
      }
    }
    // island reflection
    for (let i = 4; i < isleW - 4; i++) for (let k = 0; k < 3; k++) if (hash(i, k + Math.floor(t * 3)) > 0.4) px[(HZ + k) * W + isle0 + i] = LAND;

    // gulls
    for (const b of birds) {
      const x = Math.floor((b.x * W + t * b.s) % (W + 20)) - 10, y = Math.floor(b.y + Math.sin(t * 0.7 + b.ph) * 3);
      const up = Math.floor(t * 4 + b.ph) % 2;
      const shape = up ? [[-2, -1], [-1, 0], [0, 0], [1, 0], [2, -1]] : [[-2, 0], [-1, -1], [0, 0], [1, -1], [2, 0]];
      for (const [ox, oy] of shape) { const X = x + ox, Y = y + oy; if (X >= 0 && X < W && Y >= 0 && Y < HZ) px[Y * W + X] = BIRD; }
    }

    ctx.putImageData(img, 0, 0);
  }

  resize();
  addEventListener('resize', () => { resize(); draw(performance.now() / 1000); });
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let last = 0;
  (function loop(ms) {
    if (ms - last > 83) { last = ms; draw(ms / 1000); } // ~12 fps feels more pixel-art
    if (!still) requestAnimationFrame(loop);
  })(0);
})();
