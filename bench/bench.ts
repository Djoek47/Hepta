/**
 * npm run bench [-- --backends heuristic,jev-haiku] [--clips 01,05] [--misses] [--no-names]
 *                 [--onset-lag 0.5] [--flicker 0.08] [--seed 7]   (harsher diarization)
 *
 * Plays every clip in bench/clips through the listener once per backend and
 * prints the report. jev-haiku runs when ANTHROPIC_API_KEY is set (in the
 * environment or .env); without it the column says so instead of guessing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeClient, HAIKU, haikuTransport, HeuristicDetector, JevDetector, SonnetResponder, TemplateResponder, type HaikuTiming } from '@hepta/listen';
import type { Clip } from './src/clip.js';
import { emptyMetrics, merge, score } from './src/metrics.js';
import { formatMarkdown, formatReport, type BackendResult } from './src/report.js';
import { runClip, type Backend } from './src/run.js';

loadEnv('.env');
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k: string) => args.includes(k);

// --set holdout: the held-out clips, written after step 4 and never tuned on.
const set = arg('--set') ?? 'clips';
const clips = loadClips(set === 'holdout' ? 'bench/holdout' : 'bench/clips').filter((c) => !arg('--clips') || arg('--clips')!.split(',').some((p) => c.id.startsWith(p)));
const client = claudeClient();
const haikuTimings: HaikuTiming[] = [];

const BACKENDS: Record<string, Backend> = {
  heuristic: { name: 'heuristic', make: () => new HeuristicDetector() },
  'jev-haiku': {
    name: 'jev-haiku',
    make: () => new JevDetector({
      name: 'jev-haiku', model: HAIKU, timeoutMs: 4000,
      transport: haikuTransport({ client: client!, onTiming: (t) => haikuTimings.push(t) }),
    }),
  },
};

// Response cards: Sonnet when there is a key (that is what "time to card" should measure), else the template.
const responderName = arg('--responder') ?? (client ? 'sonnet' : 'template');
const responder = responderName === 'sonnet' && client ? new SonnetResponder({ client }) : new TemplateResponder();
const wanted = (arg('--backends') ?? 'heuristic,jev-haiku').split(',');
const results: BackendResult[] = [];
for (const name of wanted) {
  const b = BACKENDS[name];
  if (!b) { console.error(`unknown backend ${name}`); continue; }
  if (name === 'jev-haiku' && !client) {
    results.push({ backend: name, metrics: emptyMetrics(), perClip: [], note: 'not run: set ANTHROPIC_API_KEY in .env to bench Claude Haiku.' });
    continue;
  }
  const total = emptyMetrics();
  const perClip: BackendResult['perClip'] = [];
  for (const clip of clips) {
    const run = await runClip(clip, b, {
      names: !flag('--no-names'), responder,
      ...(arg('--onset-lag') ? { onsetLag: Number(arg('--onset-lag')) } : {}),
      ...(arg('--flicker') ? { flicker: Number(arg('--flicker')) } : {}),
      ...(arg('--seed') ? { seed: Number(arg('--seed')) } : {}),
    });
    const m = score(run);
    perClip.push({ clip: clip.id, metrics: m });
    merge(total, m);
    process.stderr.write(`  ${name.padEnd(10)} ${clip.id.padEnd(32)} ${run.steps.length} decisions in ${Math.round(run.wallMs)} ms\n`);
  }
  const note = name === 'jev-haiku' && haikuTimings.length
    ? `${haikuTimings.length} calls; first token median ${Math.round(med(haikuTimings.map((t) => t.ttftMs)))} ms; cache read on ${haikuTimings.filter((t) => (t.cacheReadTokens ?? 0) > 0).length}/${haikuTimings.length}.`
    : undefined;
  results.push({ backend: name, metrics: total, perClip, ...(note ? { note } : {}) });
}

const turns = clips.reduce((a, c) => a + c.turns.length, 0);
const title = `HEPTA LISTEN — bench${set === 'holdout' ? ' (HELD OUT)' : ''}: ${clips.length} clips, ${turns} turns · response cards by ${responder.name}`;
console.log('\n' + formatReport(results, title));
if (flag('--misses')) {
  for (const r of results) {
    console.log(`\n--- ${r.backend}: what it got wrong ---`);
    for (const x of r.metrics.misses) console.log(`  ${x.clip.padEnd(30)} ${x.turn.padEnd(5)} ${x.what.padEnd(22)} ${x.detail}`);
  }
}
const out = arg('--out') ?? (set === 'holdout' ? 'bench/out/holdout' : 'bench/out');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.md'), formatMarkdown(results, title) + '\n');
writeFileSync(join(out, 'report.json'), JSON.stringify({ title, at: new Date().toISOString(), results: results.map((r) => ({ ...r, metrics: { ...r.metrics, misses: r.metrics.misses } })) }, null, 1));
console.log(`\nwritten: ${join(out, 'report.md')}, ${join(out, 'report.json')}`);

function loadClips(dir: string): Clip[] {
  const out: Clip[] = [];
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (f.endsWith('.json')) out.push(JSON.parse(readFileSync(p, 'utf8')) as Clip);
    else if (existsSync(join(p, 'clip.json'))) out.push({ ...(JSON.parse(readFileSync(join(p, 'clip.json'), 'utf8')) as Clip) });
  }
  return out;
}

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
