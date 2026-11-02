// Rebuild only changed neutral geography rasters. Requires Pillow for lossless
// WebP encoding; the browser renderer is the project's locked Playwright tool.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { importedNeighborhoods } from '../public/neighborhood-catalog.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
if (process.argv.includes('--help')) {
  console.log('Rebuild changed map WebP files: node scripts/rasterize-neighborhoods.mjs\nRequires Playwright Chromium and Python Pillow. Set CHROMIUM_EXECUTABLE_PATH to use an existing Chromium binary.');
  process.exit(0);
}
const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
let rendered = 0, retained = 0;
function encode(png, rasterPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', 'import sys,io,base64,PIL; from PIL import Image; im=Image.open(io.BytesIO(base64.b64decode(sys.stdin.buffer.read()))).convert("RGBA"); im.save(sys.argv[1],format="WEBP",lossless=True,method=4); print(PIL.__version__)', rasterPath]);
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
    child.stdin.on('error', reject);
    child.stdin.end(png);
  });
}
const queue = [...importedNeighborhoods];
try {
  await Promise.all(Array.from({ length: 3 }, async () => {
    const page = await browser.newPage();
    try {
    while (queue.length) {
    const area = queue.shift();
    const config = JSON.parse(await readFile(path.join(root, 'public', area.config), 'utf8'));
    const svgPath = path.join(root, 'public', config.artwork);
    const rasterPath = path.join(root, 'public', config.rasterArtwork);
    const provenancePath = path.join(root, 'public/data', area.id, 'provenance.json');
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    const svg = await readFile(svgPath, 'utf8'), sourceSha256 = hash(svg);
    const w = config.bounds.right - config.bounds.left, h = config.bounds.bottom - config.bounds.top;
    const scale = Math.min(4, 3072 / Math.max(w, h));
    const width = Math.round(w * scale), height = Math.round(h * scale);
    try {
      if (provenance.rasterArtwork?.width === width && provenance.rasterArtwork?.height === height && provenance.rasterArtwork?.sourceSha256 === sourceSha256 && provenance.rasterArtwork.sha256 === hash(await readFile(rasterPath))) {
        retained++; continue;
      }
    } catch { /* A missing output must be generated. */ }
    const png = await page.evaluate(async ({ svg, width, height }) => {
      const tree = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (tree.querySelector('parsererror')) throw new Error('Invalid geography SVG');
      tree.documentElement.setAttribute('width', width);
      tree.documentElement.setAttribute('height', height);
      tree.documentElement.setAttribute('preserveAspectRatio', 'none');
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(tree)], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0, width, height);
        const sample = document.createElement('canvas'); sample.width = 32; sample.height = 32;
        const ctx = sample.getContext('2d'); ctx.drawImage(canvas, 0, 0, 32, 32);
        const pixels = ctx.getImageData(0, 0, 32, 32).data;
        const colors = new Set(); for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        if (colors.size < 4) throw new Error('Geography raster rendered blank');
        return canvas.toDataURL('image/png').split(',')[1];
      } finally { URL.revokeObjectURL(url); }
    }, { svg, width, height });
    const pillowVersion = await encode(png, rasterPath);
    provenance.rasterArtwork = { path: config.rasterArtwork, width, height, encoding: 'lossless WebP', sourceSha256, sha256: hash(await readFile(rasterPath)), bytes: (await stat(rasterPath)).size, renderer: browser.version(), pillowVersion };
    await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
    rendered++;
    }
    } finally { await page.close(); }
  }));
} finally { await browser.close(); }
console.log(JSON.stringify({ rendered, retained }));
