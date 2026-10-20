'use strict';
// 生成应用图标（无第三方依赖，手写最小 PNG 编码器，复用 portscan 方案）
// 造型：靛蓝渐变圆角底 + 点亮的琥珀色屏幕 + 白色边框与支架
// 输出 ICON.PNG(256) / ICON_256.PNG(256) / app/ui/images/icon_{64,128,256}.png
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const packDir = path.join(root, 'apps', 'screenctl');
const imagesDir = path.join(packDir, 'app', 'ui', 'images');

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 绘制 ----------
const BG_TOP = [0x63, 0x66, 0xf1];
const BG_BOTTOM = [0x4a, 0x3f, 0xc0];
const FG = [0xff, 0xff, 0xff];
const SCREEN_TOP = [0xff, 0xd9, 0x7a];
const SCREEN_BOTTOM = [0xf5, 0x9e, 0x0b];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// 4x4 超采样抗锯齿
function coverage(px, py, sdf) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (sdf(px + (sx + 0.5) / 4, py + (sy + 0.5) / 4)) hits++;
    }
  }
  return hits / 16;
}

function roundedRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
    const qy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
  };
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = size;

  // 形状定义（比例坐标）
  const body = roundedRect(0.02 * S, 0.02 * S, 0.98 * S, 0.98 * S, 0.22 * S);
  const screenOuter = roundedRect(0.20 * S, 0.22 * S, 0.80 * S, 0.60 * S, 0.055 * S);
  const screenInner = roundedRect(0.255 * S, 0.275 * S, 0.745 * S, 0.545 * S, 0.03 * S);
  const standV = roundedRect(0.478 * S, 0.60 * S, 0.522 * S, 0.72 * S, 0.014 * S);
  const standH = roundedRect(0.34 * S, 0.72 * S, 0.66 * S, 0.765 * S, 0.018 * S);
  // 屏幕内高光小圆（右上角，模拟反光）
  const glint = (x, y) => {
    const dx = x - 0.62 * S;
    const dy = y - 0.36 * S;
    return Math.hypot(dx, dy) <= 0.045 * S;
  };

  const frameW = Math.max(1, S * 0.026); // 白色边框厚度

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * S + x) * 4;

      if (!coverage(px, py, body)) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
        continue;
      }

      const t = py / S;
      let color = mix(BG_TOP, BG_BOTTOM, t);

      if (coverage(px, py, screenOuter)) {
        if (coverage(px, py, screenInner)) {
          // 点亮的屏幕：琥珀渐变
          color = mix(SCREEN_TOP, SCREEN_BOTTOM, (py - 0.275 * S) / (0.27 * S));
          if (coverage(px, py, glint)) color = mix(color, FG, 0.55);
        } else {
          color = FG; // 白色边框
        }
      }
      if (coverage(px, py, standV) || coverage(px, py, standH)) {
        color = FG;
      }

      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }

  return encodePng(S, S, rgba);
}

// ---------- 输出 ----------
fs.mkdirSync(imagesDir, { recursive: true });

const targets = [
  [64, path.join(imagesDir, 'icon_64.png')],
  [128, path.join(imagesDir, 'icon_128.png')],
  [256, path.join(imagesDir, 'icon_256.png')],
  [256, path.join(packDir, 'ICON.PNG')],
  [256, path.join(packDir, 'ICON_256.PNG')]
];

for (const [size, out] of targets) {
  const buf = drawIcon(size);
  fs.writeFileSync(out, buf);
  console.log(`[icon] ${path.relative(root, out)} (${size}x${size}, ${buf.length} bytes)`);
}
