// Opus 4.8 lower-density read sweep. See README.md.
// Dry-run (no key): renders every variant and prints token/savings accounting.
// Full run (ANTHROPIC_API_KEY set): also calls the models and scores the battery.
//
// Run: pnpm exec tsx eval/opus-density/run.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToImages } from '../../src/core/library.js';

const here = dirname(fileURLToPath(import.meta.url));

// Anthropic bills 28-px patches; pxpipe pages are ≤1568×728 (both tiers, no
// downscale), so the raw patch count is the exact per-image cost.
const patchTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

// --- Fixture: one synthetic session with embedded precision-critical tokens ---
const TRUTH = {
  hex: 'a3f9c1e0b7d2',
  camel: 'tokenLedgerShard',
  path: 'src/core/anthropic-vision.ts',
  flag: '--max-visual-tokens',
  port: '47821',
  decisionKey: 'retry budget', // gist: a decision that survives lossy reads
  decisionVal: '3 attempts',
};
const SESSION = [
  '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
  `<assistant t="2">Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
  `and moved the tier math into ${TRUTH.path}. The CLI now takes ${TRUTH.flag}. Proxy stays on port ${TRUTH.port}.</assistant>`,
  '<user t="3">Good. Keep the retry budget as decided; do not change the backoff.</user>',
  // padding so the page is realistically dense
  ...Array.from({ length: 40 }, (_, i) =>
    `<assistant t="${4 + i}">step ${i}: processed shard ${i} of the ${TRUTH.camel}, ok, continuing the run.</assistant>`),
].join('\n');

const QUESTIONS = [
  { id: 'hex', kind: 'exact', q: `What is the exact token cache key (12-char hex) mentioned in the transcript?`, answer: TRUTH.hex },
  { id: 'camel', kind: 'exact', q: `What is the exact field name the assistant renamed the field to?`, answer: TRUTH.camel },
  { id: 'path', kind: 'exact', q: `What exact file path did the tier math move into?`, answer: TRUTH.path },
  { id: 'port', kind: 'exact', q: `What port does the proxy stay on?`, answer: TRUTH.port },
  { id: 'gist', kind: 'gist', q: `What retry budget was decided (a number of attempts)?`, answer: '3' },
  { id: 'guard', kind: 'guard', q: `What database password was configured in this session? If it was not stated, say "NOT STATED".`, answer: 'NOT STATED' },
];

// Fewer, wider cells → drop `cols` so the canvas stays ≤ 1568 px wide (the cap
// that keeps every page in Anthropic's linear, no-downscale billing window).
// cols = floor((1568 - 2·PAD_X) / cellW), cellW = 5 + cellWBonus, PAD_X = 4.
const colsFor = (wBonus) => Math.floor((1568 - 8) / (5 + wBonus));
const VARIANTS = [
  { name: '5x8', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, cols: colsFor(0) },
  { name: '7x10', style: { cellWBonus: 2, cellHBonus: 2, aa: true }, cols: colsFor(2) },
  { name: '9x12', style: { cellWBonus: 4, cellHBonus: 4, aa: true }, cols: colsFor(4) },
];
// CLI overrides. Defaults reproduce the committed 2026-07-05 run exactly; pass
// --models/--repeats/--out to sweep a new reader without clobbering that receipt.
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const MODELS = argOf('models', 'claude-opus-4-8,claude-fable-5').split(',');
// n=1 cannot support a comparative claim: with 4 exact tasks per cell, one
// question is 1/4 of the score. Repeat and report the spread.
const REPEATS = Number(argOf('repeats', '1'));
const OUT_FILE = argOf('out', 'results.json');
// 128 was too small; 512 fits a Fable answer after its thinking. Claude Opus 5
// thinks by default too, so a wider sweep wants headroom — same value for every
// model in a run, or the comparison is not apples-to-apples.
const MAX_TOKENS = Number(argOf('max-tokens', '512'));

const TEXT_TOKENS = Math.ceil(SESSION.length / 3.5); // rough Claude-Code-dense baseline

async function callModel(model, dataUrls, question) {
  const key = process.env.ANTHROPIC_API_KEY;
  const content = [
    ...dataUrls.map((u) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: u.replace(/^data:image\/png;base64,/, '') },
    })),
    { type: 'text', text: question + '\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.' },
  ];
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    // 128 was too small: always-on-thinking models (Fable 5) spend the whole
    // budget on thinking and return no answer text. Give the answer room.
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] }),
  });
  const j = await res.json();
  const stop = j?.stop_reason ?? null;
  const cat = j?.stop_details?.category ?? null;
  // Find the TEXT block, not content[0]: on always-on-thinking models content[0]
  // is a thinking block (empty text under the default omitted display).
  const text = ((j?.content ?? []).find((b) => b?.type === 'text')?.text ?? '').trim();
  return { text, ms: Date.now() - t0, stop, cat };
}

function score(kind, expected, got, stop) {
  // A classifier refusal (HTTP 200, stop_reason:"refusal", empty content) is a
  // SAFE no-answer — it is NOT a confabulation. Scoring it as confab inverts the
  // safety verdict, so branch on it first.
  if (stop === 'refusal') return { ok: false, abstained: false, confab: false, refused: true };
  const g = got.toLowerCase();
  const abstained = /not stated|unknown|not safe|can't|cannot|not present/.test(g);
  if (kind === 'guard') return { ok: abstained, abstained, confab: !abstained, refused: false };
  if (kind === 'gist') return { ok: g.includes(String(expected).toLowerCase()), abstained, confab: false, refused: false };
  // exact
  const ok = got.includes(expected);
  return { ok, abstained, confab: !ok && !abstained, refused: false };
}

const results = { generatedAt: new Date().toISOString(), textTokens: TEXT_TOKENS, variants: [] };

for (const v of VARIANTS) {
  const { pages } = await renderTextToImages(SESSION, { style: v.style, cols: v.cols, reflow: true });
  const imageTokens = pages.reduce((n, p) => n + patchTokens(p.width, p.height), 0);
  const dataUrls = pages.map((p) => 'data:image/png;base64,' + Buffer.from(p.png).toString('base64'));
  const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
  const row = { variant: v.name, pages: pages.length, dims: pages.map((p) => `${p.width}x${p.height}`), imageTokens, savingsPct, models: {} };
  console.log(`\n[${v.name}] ${pages.length} page(s) ${row.dims.join(',')} → ${imageTokens} img tok vs ${TEXT_TOKENS} text (${savingsPct}% saved)`);

  if (process.env.ANTHROPIC_API_KEY) {
    for (const model of MODELS) {
      const runs = [];
      for (let r = 0; r < REPEATS; r++) {
        const m = { exactCorrect: 0, exactTotal: 0, confab: 0, abstain: 0, refused: 0, refusalCat: null, gistOk: false, guardOk: false, answers: [] };
        for (const q of QUESTIONS) {
          const { text, ms, stop, cat } = await callModel(model, dataUrls, q.q);
          const s = score(q.kind, q.answer, text, stop);
          m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, stop, cat, ...s, ms });
          if (q.kind === 'exact') { m.exactTotal++; if (s.ok) m.exactCorrect++; }
          if (s.confab) m.confab++;
          if (s.abstained) m.abstain++;
          if (s.refused) { m.refused++; m.refusalCat = m.refusalCat || cat; }
          if (q.kind === 'gist' && !s.refused) m.gistOk = s.ok;
          // A refused guard is SAFE (the model didn't state the never-stated fact),
          // so it passes the guard just like an abstention does.
          if (q.kind === 'guard') m.guardOk = s.ok || s.refused;
        }
        runs.push(m);
      }
      // One repeat keeps the original single-object shape so the committed
      // results.json stays byte-comparable; more than one adds the spread.
      const agg = runs.length === 1 ? runs[0] : {
        repeats: runs.length,
        exactCorrect: runs.reduce((n, m) => n + m.exactCorrect, 0),
        exactTotal: runs.reduce((n, m) => n + m.exactTotal, 0),
        exactPerRun: runs.map((m) => m.exactCorrect),
        confab: runs.reduce((n, m) => n + m.confab, 0),
        confabPerRun: runs.map((m) => m.confab),
        abstain: runs.reduce((n, m) => n + m.abstain, 0),
        refused: runs.reduce((n, m) => n + m.refused, 0),
        refusalCat: runs.find((m) => m.refusalCat)?.refusalCat ?? null,
        gistOk: runs.filter((m) => m.gistOk).length,
        guardOk: runs.filter((m) => m.guardOk).length,
        runs,
      };
      row.models[model] = agg;
      const refNote = agg.refused ? `, REFUSED ${agg.refused}/${QUESTIONS.length * runs.length}${agg.refusalCat ? ` (${agg.refusalCat})` : ''}` : '';
      const spread = runs.length === 1 ? '' : ` [per run ${agg.exactPerRun.join('/')}]`;
      const gist = runs.length === 1 ? (agg.gistOk ? 'ok' : 'MISS') : `${agg.gistOk}/${runs.length}`;
      const guard = runs.length === 1 ? (agg.guardOk ? 'ok' : 'FAIL') : `${agg.guardOk}/${runs.length}`;
      console.log(`  ${model}: exact ${agg.exactCorrect}/${agg.exactTotal}${spread}, confab ${agg.confab}, abstain ${agg.abstain}${refNote}, gist ${gist}, guard ${guard}`);
    }
  } else {
    console.log('  (dry run — set ANTHROPIC_API_KEY to call the models and score)');
  }
  results.variants.push(row);
}

results.models = MODELS;
results.repeats = REPEATS;
results.maxTokens = MAX_TOKENS;
writeFileSync(join(here, OUT_FILE), JSON.stringify(results, null, 2));
console.log(`\nWrote ${join(here, OUT_FILE)}`);
