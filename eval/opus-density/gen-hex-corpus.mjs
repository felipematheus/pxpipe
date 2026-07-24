// Dense-hex corpus rendered at the three opus-density cell sizes.
//
// The published `dense hex (N=15)` battery (eval/verbatim-15) ships pre-rendered
// pages at one density only, and no generator, so it cannot answer "does Opus
// read better with bigger cells". This regenerates an equivalent corpus — same
// task shape: find the JSON line with an exact dur_ms, transcribe its 12-hex id —
// and renders it at 5x8 / 7x10 / 9x12, all inside the ≤1568×728 cap that keeps
// pages in Anthropic's linear, no-downscale billing window.
//
//   pnpm exec tsx eval/opus-density/gen-hex-corpus.mjs <out-dir> [--lines N] [--probes N]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderTextToImages } from '../../src/core/library.js';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: gen-hex-corpus.mjs <out-dir> [--lines N] [--probes N]'); process.exit(1); }
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : Number(process.argv[i + 1]); };
const LINES = argOf('lines', 100);
const PROBES = argOf('probes', 15);
mkdirSync(OUT, { recursive: true });

// Deterministic PRNG so a re-run reproduces the same corpus and golds.
let seed = 0x9e3779b9;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
const hex12 = () => Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

const OPS = ['flush', 'render', 'encode', 'collapse', 'reflow', 'patch', 'sweep', 'commit'];
const rows = [];
const usedDur = new Set();
for (let i = 0; i < LINES; i++) {
  let dur;
  do { dur = 1000 + Math.floor(rnd() * 9000); } while (usedDur.has(dur)); // unique => unambiguous probe
  usedDur.add(dur);
  rows.push({ id: hex12(), dur_ms: dur, op: OPS[Math.floor(rnd() * OPS.length)] });
}
const CORPUS = rows.map((r) => JSON.stringify(r)).join('\n');

// Probes spread evenly through the corpus so no density is advantaged by
// probes clustering at the top of the page.
const golds = [];
for (let k = 0; k < PROBES; k++) {
  const r = rows[Math.floor((k + 0.5) * LINES / PROBES)];
  golds.push({ dur: r.dur_ms, gold: r.id });
}
writeFileSync(join(OUT, 'golds.json'), JSON.stringify(golds, null, 1));
writeFileSync(join(OUT, 'corpus.txt'), CORPUS);

const colsFor = (wBonus) => Math.floor((1568 - 8) / (5 + wBonus));
const VARIANTS = [
  { name: '5x8', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, cols: colsFor(0) },
  { name: '7x10', style: { cellWBonus: 2, cellHBonus: 2, aa: true }, cols: colsFor(2) },
  { name: '9x12', style: { cellWBonus: 4, cellHBonus: 4, aa: true }, cols: colsFor(4) },
];
const patchTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

const manifest = [];
for (const v of VARIANTS) {
  const { pages } = await renderTextToImages(CORPUS, { style: v.style, cols: v.cols, reflow: true });
  // Multi-page would make a probe ambiguous (which page holds the line?), so
  // fail loudly rather than silently scoring against the wrong image.
  if (pages.length !== 1) throw new Error(`${v.name} rendered ${pages.length} pages; lower --lines`);
  const p = pages[0];
  writeFileSync(join(OUT, `${v.name}.png`), p.png);
  const tok = patchTokens(p.width, p.height);
  manifest.push({ variant: v.name, dims: `${p.width}x${p.height}`, imageTokens: tok });
  console.log(`${v.name}: ${p.width}x${p.height}  ${tok} img tokens`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ lines: LINES, probes: PROBES, variants: manifest }, null, 1));
console.log(`corpus: ${LINES} lines, ${PROBES} probes -> ${OUT}`);
