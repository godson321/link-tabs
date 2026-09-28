// 图标生成流水线（第二步）：把高分辨率母图 icon-master.png 面积平均缩放到
// 16/32/48/128，并手写 PNG 编码输出到 icons/。
//
// 用法（在仓库根目录执行）：
//   node tools/make-icons.mjs
//
// 第一步是渲染母图（1024×1024、透明背景），用无头 Edge 执行：
//   "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
//     --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
//     --default-background-color=00000000 --user-data-dir="$TEMP/edge-icon-master" \
//     --screenshot="<仓库根>/icon-master.png" --window-size=1024,1024 --virtual-time-budget=5000 \
//     "file:///<仓库根>/tools/icon-render.html"
//
// 之所以不直接按目标尺寸截图：无头 Edge 在小窗口下存在渲染竞态，96/128 等尺寸会
// 得到全透明空图（64/200 正常，且可复现）。改为“渲染一次大图 + 自行缩放”后结果稳定，
// 抗锯齿质量也更好。图形本体在 tools/icon-render.html 中，改图形只需改那个文件。
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const MASTER = "icon-master.png";
const SIZES = [16, 32, 48, 128];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(path) {
  const buf = readFileSync(path);
  let offset = 8, ihdr = null;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + len;
  }
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${path}: 需要 8bit RGBA 非隔行 PNG（实际 depth=${bitDepth} colorType=${colorType} interlace=${interlace}）`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** 面积平均缩放，在预乘 alpha 空间累加，避免半透明边缘出现暗边。 */
function downscale(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy0 = (y * srcH) / dstH;
    const sy1 = ((y + 1) * srcH) / dstH;
    for (let x = 0; x < dstW; x++) {
      const sx0 = (x * srcW) / dstW;
      const sx1 = ((x + 1) * srcW) / dstW;
      let sr = 0, sg = 0, sb = 0, sa = 0, weight = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          const w = wx * wy;
          const i = (sy * srcW + sx) * 4;
          const alpha = src[i + 3] / 255;
          sr += src[i] * alpha * w;
          sg += src[i + 1] * alpha * w;
          sb += src[i + 2] * alpha * w;
          sa += alpha * w;
          weight += w;
        }
      }
      const o = (y * dstW + x) * 4;
      const outAlpha = sa / weight;
      out[o + 3] = Math.round(outAlpha * 255);
      if (sa > 0) {
        out[o] = Math.round(sr / sa);
        out[o + 1] = Math.round(sg / sa);
        out[o + 2] = Math.round(sb / sa);
      }
    }
  }
  return out;
}

const master = decodePng(MASTER);
let opaque = 0;
for (let i = 3; i < master.data.length; i += 4) if (master.data[i] > 200) opaque++;
const ratio = opaque / (master.width * master.height);
console.log(`母图 ${master.width}x${master.height}，不透明像素占比 ${(ratio * 100).toFixed(1)}%`);
if (ratio < 0.5) throw new Error("母图内容为空，先按文件头注释重新渲染 icon-master.png");

for (const size of SIZES) {
  const scaled = downscale(master.data, master.width, master.height, size, size);
  const path = `icons/icon${size}.png`;
  writeFileSync(path, encodePng(size, size, scaled));
  console.log(`已写出 ${path}`);
}
