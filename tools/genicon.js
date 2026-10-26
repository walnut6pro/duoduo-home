// 纯 Node 生成 PWA 图标（不依赖任何第三方库，使用内置 zlib）
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 512;
const buf = Buffer.alloc(SIZE * SIZE * 4); // RGBA

function setPix(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // alpha 合成到透明背景
  const sa = a / 255;
  buf[i] = Math.round(r * sa + buf[i] * (1 - sa));
  buf[i + 1] = Math.round(g * sa + buf[i + 1] * (1 - sa));
  buf[i + 2] = Math.round(b * sa + buf[i + 2] * (1 - sa));
  buf[i + 3] = Math.max(buf[i + 3], a);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// 垂直渐变背景 + 圆角矩形
function roundRectBg(x0, y0, w, h, r, c1, c2) {
  for (let y = y0; y < y0 + h; y++) {
    const t = (y - y0) / h;
    const R = Math.round(lerp(c1[0], c2[0], t));
    const G = Math.round(lerp(c1[1], c2[1], t));
    const B = Math.round(lerp(c1[2], c2[2], t));
    for (let x = x0; x < x0 + w; x++) {
      // 圆角判断
      let inside = true;
      const cx = x0 + r, cy = y0 + r, cx2 = x0 + w - r, cy2 = y0 + h - r;
      if (x < cx && y < cy) { if ((cx - x) ** 2 + (cy - y) ** 2 > r * r) inside = false; }
      else if (x > cx2 && y < cy) { if ((x - cx2) ** 2 + (cy - y) ** 2 > r * r) inside = false; }
      else if (x < cx && y > cy2) { if ((cx - x) ** 2 + (cy2 - y) ** 2 > r * r) inside = false; }
      else if (x > cx2 && y > cy2) { if ((x - cx2) ** 2 + (y - cy2) ** 2 > r * r) inside = false; }
      if (inside) setPix(x, y, R, G, B, 255);
    }
  }
}

function fillTri(ax, ay, bx, by, cx, cy, color, a) {
  const minX = Math.floor(Math.min(ax, bx, cx)), maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy)), maxY = Math.ceil(Math.max(ay, by, cy));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) setPix(x, y, color[0], color[1], color[2], a);
    }
  }
}

function fillRect(x0, y0, w, h, color, a) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++)
      setPix(x, y, color[0], color[1], color[2], a);
}

// 背景：蓝紫渐变圆角
roundRectBg(0, 0, SIZE, SIZE, 110, [59, 110, 245], [122, 92, 255]);

// 小房子（白色）
const WHITE = [255, 255, 255];
const BG_CUT = [103, 97, 252]; // 近似该高度背景色，用于挖空门窗
// 烟囱（先画，屋顶会盖住下方）
fillRect(322, 150, 34, 120, WHITE, 255);
// 屋顶
fillTri(256, 135, 100, 290, 412, 290, WHITE, 255);
// 墙体
fillRect(150, 290, 212, 140, WHITE, 255);
// 门
fillRect(238, 350, 44, 80, BG_CUT, 255);
// 窗（左右）
fillRect(180, 320, 36, 36, BG_CUT, 255);
fillRect(296, 320, 36, 36, BG_CUT, 255);

// ---- PNG 编码 ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const cd = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0);
  return Buffer.concat([len, cd, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行前加 filter 0
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-512.png'), encodePNG(buf, SIZE, SIZE));
// 192 缩放（简单最近邻）
function scale(src, s, ns) {
  const out = Buffer.alloc(ns * ns * 4);
  for (let y = 0; y < ns; y++)
    for (let x = 0; x < ns; x++) {
      const sx = Math.min(SIZE - 1, Math.floor(x / s));
      const sy = Math.min(SIZE - 1, Math.floor(y / s));
      src.copy(out, (y * ns + x) * 4, (sy * SIZE + sx) * 4, (sy * SIZE + sx) * 4 + 4);
    }
  return out;
}
fs.writeFileSync(path.join(outDir, 'icon-192.png'), encodePNG(scale(buf, 512 / 192, 192), 192, 192));
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), encodePNG(scale(buf, 512 / 180, 180), 180, 180));
console.log('icons generated:', outDir);
