// 由用户提供的源图标（tools/icon-source.png）生成 PWA 各尺寸图标
// 纯 Node 实现：PNG 解码(RGBA/非隔行) → 双线性缩放 → 合成浅色方形底 → PNG 编码
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SRC_PATH = path.join(__dirname, 'icon-source.png');
const OUT_DIR = path.join(__dirname, '..', 'icons');

/* ---------- PNG 解码 ---------- */
function decodePNG(buf) {
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('仅支持 8bit RGBA，当前 bitDepth=' + bitDepth + ' colorType=' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const row = raw.slice(pos, pos + stride); pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;          // 左
      const b = prev ? prev[x] : 0;                    // 上
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;// 左上
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, rgba: out };
}

/* ---------- 双线性采样（返回 r,g,b,a 0-255） ---------- */
function sample(img, fx, fy) {
  const { w, h, rgba } = img;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  const cl = (v, m) => v < 0 ? 0 : (v > m ? m : v);
  x0 = cl(x0, w - 1); x1 = cl(x1, w - 1); y0 = cl(y0, h - 1); y1 = cl(y1, h - 1);
  const px = (X, Y) => { const i = (Y * w + X) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]; };
  const p00 = px(x0, y0), p10 = px(x1, y0), p01 = px(x0, y1), p11 = px(x1, y1);
  const mix = (a, b, c, d) => Math.round(
    a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
  );
  return [mix(p00[0], p10[0], p01[0], p11[0]),
          mix(p00[1], p10[1], p01[1], p11[1]),
          mix(p00[2], p10[2], p01[2], p11[2]),
          mix(p00[3], p10[3], p01[3], p11[3])];
}

/* ---------- 合成：浅色渐变方底 + 居中图 ---------- */
const BG_TOP = [246, 243, 255];   // 浅薰衣草
const BG_BOT = [230, 238, 255];   // 浅蓝
const FIT = 0.86;                 // 图像占画布比例

function compose(img, N) {
  const out = Buffer.alloc(N * N * 4);
  // 1) 背景渐变（不透明，避免 iOS 透明底发灰）
  for (let y = 0; y < N; y++) {
    const t = y / (N - 1 || 1);
    const r = Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t);
    const g = Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t);
    const b = Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t);
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }
  // 2) 等比缩放居中，按 alpha 合成
  const scale = Math.min(N * FIT / img.w, N * FIT / img.h);
  const dw = img.w * scale, dh = img.h * scale;
  const ox = (N - dw) / 2, oy = (N - dh) / 2;
  const x0 = Math.floor(ox), x1 = Math.ceil(ox + dw);
  const y0 = Math.floor(oy), y1 = Math.ceil(oy + dh);
  for (let y = Math.max(0, y0); y < Math.min(N, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(N, x1); x++) {
      const fx = (x + 0.5 - ox) / scale - 0.5;
      const fy = (y + 0.5 - oy) / scale - 0.5;
      const c = sample(img, fx, fy);
      const a = c[3] / 255;
      if (a <= 0) continue;
      const i = (y * N + x) * 4;
      out[i] = Math.round(c[0] * a + out[i] * (1 - a));
      out[i + 1] = Math.round(c[1] * a + out[i + 1] * (1 - a));
      out[i + 2] = Math.round(c[2] * a + out[i + 2] * (1 - a));
      out[i + 3] = 255;
    }
  }
  return out;
}

/* ---------- PNG 编码 ---------- */
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
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 主流程 ---------- */
const src = decodePNG(fs.readFileSync(SRC_PATH));
console.log('源图标:', src.w + 'x' + src.h, 'RGBA');
fs.mkdirSync(OUT_DIR, { recursive: true });
[[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'apple-touch-icon.png']].forEach(function (t) {
  const buf = encodePNG(compose(src, t[0]), t[0], t[0]);
  fs.writeFileSync(path.join(OUT_DIR, t[1]), buf);
  console.log('生成', t[1], t[0] + 'x' + t[0], (buf.length / 1024).toFixed(1) + 'KB');
});
