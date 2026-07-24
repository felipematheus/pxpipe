// Opus-density read sweep over the Claude Code CLI transport (no API key).
//
// Same fixture, variants, battery and scoring as run.mjs — the difference is
// transport: instead of POSTing base64 images to /v1/messages with an x-api-key,
// each question is a separate `claude -p --model X` invocation that Reads the
// rendered PNG off disk. That uses the CLI's own session auth.
//
//   pnpm exec tsx eval/opus-density/run-cli.mjs [--models a,b] [--out FILE]
//
// CAVEAT — this is NOT interchangeable with run.mjs's numbers. The CLI wraps
// every question in Claude Code's system prompt and tool loop, and the image
// reaches the model through the Read tool, which may preprocess or downscale it.
// The density ladder is the internal control: run.mjs's committed receipt shows
// exact recall climbing monotonically 1/4 → 3/4 → 4/4 as cells get bigger. If
// that ladder reproduces here, the transport preserved density; if results are
// flat across variants, the transport altered the pixels and the run is void.
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderTextToImages } from '../../src/core/library.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const MODELS = argOf('models', 'claude-opus-5,claude-fable-5').split(',');
const OUT_FILE = argOf('out', 'results-cli.json');
const IMG_DIR = argOf('img-dir', join(here, '_cli-imgs'));
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

// --- Fixture: identical to run.mjs ------------------------------------------
const TRUTH = {
  hex: 'a3f9c1e0b7d2',
  camel: 'tokenLedgerShard',
  path: 'src/core/anthropic-vision.ts',
  flag: '--max-visual-tokens',
  port: '47821',
};
const SESSION = [
  '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
  `<assistant t="2">Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
  `and moved the tier math into ${TRUTH.path}. The CLI now takes ${TRUTH.flag}. Proxy stays on port ${TRUTH.port}.</assistant>`,
  '<user t="3">Good. Keep the retry budget as decided; do not change the backoff.</user>',
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

const colsFor = (wBonus) => Math.floor((1568 - 8) / (5 + wBonus));
const VARIANTS = [
  { name: '5x8', style: { cellWBonus: 0, cellHBonus: 0, aa: true }, cols: colsFor(0) },
  { name: '7x10', style: { cellWBonus: 2, cellHBonus: 2, aa: true }, cols: colsFor(2) },
  { name: '9x12', style: { cellWBonus: 4, cellHBonus: 4, aa: true }, cols: colsFor(4) },
];

const patchTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
const TEXT_TOKENS = Math.ceil(SESSION.length / 3.5);

// Scoring is byte-identical to run.mjs, minus the API-only `refusal` stop_reason
// (the CLI does not surface it — a refusal arrives as ordinary answer text, so
// it lands in `abstained` instead, which is also the safe bucket).
function score(kind, expected, got) {
  const g = got.toLowerCase();
  const abstained = /not stated|unknown|not safe|can't|cannot|not present|unable/.test(g);
  if (kind === 'guard') return { ok: abstained, abstained, confab: !abstained };
  if (kind === 'gist') return { ok: g.includes(String(expected).toLowerCase()), abstained, confab: false };
  const ok = got.includes(expected);
  return { ok, abstained, confab: !ok && !abstained };
}

async function askCLI(model, imgPath, question) {
  const prompt =
    `Read the image at ${imgPath}. It is a densely rendered transcript. ` +
    `${question}\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.`;
  const t0 = Date.now();
  try {
    const { stdout } = await execFileAsync(
      CLAUDE_BIN,
      ['-p', prompt, '--model', model, '--allowedTools', 'Read', '--output-format', 'json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
    );
    const j = JSON.parse(stdout);
    return { text: String(j.result ?? '').trim(), ms: Date.now() - t0, usd: j.usage?.costUSD ?? j.total_cost_usd ?? null, err: null };
  } catch (e) {
    return { text: '', ms: Date.now() - t0, usd: null, err: String(e.message ?? e).slice(0, 200) };
  }
}

mkdirSync(IMG_DIR, { recursive: true });
const results = { generatedAt: new Date().toISOString(), transport: 'claude-code-cli', models: MODELS, textTokens: TEXT_TOKENS, variants: [] };

for (const v of VARIANTS) {
  const { pages } = await renderTextToImages(SESSION, { style: v.style, cols: v.cols, reflow: true });
  if (pages.length !== 1) throw new Error(`variant ${v.name} rendered ${pages.length} pages; the CLI probe assumes 1`);
  const p = pages[0];
  const imgPath = join(IMG_DIR, `${v.name}.png`);
  writeFileSync(imgPath, p.png);
  const imageTokens = patchTokens(p.width, p.height);
  const savingsPct = Math.round((1 - imageTokens / TEXT_TOKENS) * 100);
  const row = { variant: v.name, dims: `${p.width}x${p.height}`, imageTokens, savingsPct, models: {} };
  console.log(`\n[${v.name}] ${row.dims} → ${imageTokens} img tok vs ${TEXT_TOKENS} text (${savingsPct}% saved)`);

  for (const model of MODELS) {
    const m = { exactCorrect: 0, exactTotal: 0, confab: 0, abstain: 0, errors: 0, gistOk: false, guardOk: false, usd: 0, answers: [] };
    for (const q of QUESTIONS) {
      const { text, ms, usd, err } = await askCLI(model, imgPath, q.q);
      if (err) { m.errors++; m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: '', err, ms }); continue; }
      const s = score(q.kind, q.answer, text);
      m.answers.push({ id: q.id, kind: q.kind, expected: q.answer, got: text, ...s, ms, usd });
      if (usd) m.usd += usd;
      if (q.kind === 'exact') { m.exactTotal++; if (s.ok) m.exactCorrect++; }
      if (s.confab) m.confab++;
      if (s.abstained) m.abstain++;
      if (q.kind === 'gist') m.gistOk = s.ok;
      if (q.kind === 'guard') m.guardOk = s.ok;
    }
    row.models[model] = m;
    const errNote = m.errors ? `, ERRORS ${m.errors}` : '';
    console.log(`  ${model}: exact ${m.exactCorrect}/${m.exactTotal}, confab ${m.confab}, abstain ${m.abstain}${errNote}, gist ${m.gistOk ? 'ok' : 'MISS'}, guard ${m.guardOk ? 'ok' : 'FAIL'}, ~$${m.usd.toFixed(2)}`);
  }
  results.variants.push(row);
  writeFileSync(join(here, OUT_FILE), JSON.stringify(results, null, 2));
}

console.log(`\nWrote ${join(here, OUT_FILE)}`);
