/**
 * npm run bench:debug -- 01 [--partials]
 * One clip, turn by turn: what the labels say next to what the listener decided.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HeuristicDetector } from '@hepta/listen';
import type { Clip } from './src/clip.js';
import { runClip } from './src/run.js';

const id = process.argv[2] ?? '01';
const partials = process.argv.includes('--partials');
const f = readdirSync('bench/clips').find((x) => x.startsWith(id) && x.endsWith('.json'))!;
const clip = JSON.parse(readFileSync(join('bench/clips', f), 'utf8')) as Clip;
const run = await runClip(clip, { name: 'heuristic', make: () => new HeuristicDetector() });
const turns = new Map(clip.turns.map((t) => [t.id, t]));
let last = '';
for (const s of run.steps) {
  const d = s.d;
  if (!d.final && !partials) continue;
  const t = turns.get(s.sc.turnId)!;
  if (t.id !== last) {
    const want = [t.topic ?? '', t.shift && t.shift !== 'none' ? t.shift : '', t.diversion?.join('/') ?? '', t.question ? `asks ${t.question.id}→${t.question.to}` : '', t.answers ? `answers ${t.answers}` : '', t.hepta ?? ''].filter(Boolean).join(' · ');
    console.log(`\n${t.id} ${t.speaker}: ${t.text}\n   want: ${want}`);
    last = t.id;
  }
  const got = [d.ignored ? `ignored:${d.ignored}` : '', d.topic ?? '∅', d.shiftType !== 'none' ? `${d.shiftType} (from ${d.shiftFrom})` : '', d.diversion ? `DIV ${d.diversion.type}` : '',
    d.questionId ? `q ${d.questionId}` : '', d.answers ? `answers ${d.answers}` : '', d.dodged?.length ? `dodged ${d.dodged.join(',')}` : '',
    d.claim ? `claim ${d.claim.subject}=${d.claim.value}${d.claim.contradicts ? ' ✗' + (d.claim.contradicts.claimId ?? d.claim.contradicts.evidenceId) : ''}` : '',
    d.respondState !== 'listen' ? d.respondState.toUpperCase() : ''].filter(Boolean).join(' · ');
  console.log(`   ${d.final ? 'got ' : '  … '} ${d.speaker} "${d.text.slice(0, 70)}": ${got}`);
}
const m = run.listener.memory;
console.log('\nthreads:', m.threads.map((t) => `${t.topic}(${t.weight.toFixed(2)}${t.onAir ? ' ON AIR' : ''})`).join(', '));
console.log('questions:', m.questions.map((q) => `${q.id} ${q.by}→${q.to} [${q.status}${q.turnsSince ? ' ' + q.turnsSince + ' turns' : ''}] "${q.text}"`).join('\n           '));
