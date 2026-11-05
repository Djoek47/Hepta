/**
 * npm run bench:report
 * Runs the scripted set and the held-out set (and recorded clips, if any), then
 * writes bench/REPORT.md: the numbers, what each one means, and what went wrong.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { BackendResult } from './src/report.js';
import { rows } from './src/report.js';
import { precision, recall, type PR } from './src/metrics.js';

type Out = { title: string; at: string; results: BackendResult[] };
const read = (p: string): Out | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Out) : null);
const dev = read('bench/out/report.json');
const held = read('bench/out/holdout/report.json');
if (!dev) { console.error('run the bench first'); process.exit(1); }

const sh = (c: string) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return '?'; } };
const commit = sh('git rev-parse --short HEAD');
const f2 = (n: number | null) => (n === null ? '—' : n.toFixed(2));
const prs = (x: PR) => `${f2(precision(x))} / ${f2(recall(x))}`;

function table(o: Out): string {
  const rs = rows(o.results);
  const head = `| | ${o.results.map((r) => r.backend).join(' | ')} | |\n|---|${o.results.map(() => '---').join('|')}|---|`;
  return [head, ...rs.map((r) => `| ${r.label.trim()} | ${r.cells.join(' | ')} | ${r.note ?? ''} |`)].join('\n')
    + o.results.filter((r) => r.note).map((r) => `\n\n**${r.backend}:** ${r.note}`).join('');
}

function perClip(o: Out): string {
  const out: string[] = [];
  for (const r of o.results) {
    if (!r.perClip.length) continue;
    out.push(`**${r.backend}**`, '', '| clip | shift P/R | diversion P/R | dodges P/R | contradictions P/R | wrong interruptions | responses |', '|---|---|---|---|---|---|---|');
    for (const c of r.perClip) {
      const m = c.metrics;
      out.push(`| ${c.clip} | ${prs(m.shift)} | ${prs(m.diversion)} | ${prs(m.dodged)} | ${prs(m.contradiction)} | ${m.respond.wrongInterruptions} | ${m.respond.hit}/${m.respond.expected} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function misses(o: Out): string {
  const r = o.results.find((x) => x.perClip.length);
  if (!r) return '';
  return r.metrics.misses.map((m) => `- \`${m.clip}\` ${m.turn} — **${m.what}**: ${m.detail}`).join('\n');
}

const md = `# Hepta Listen — bench report

Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC at commit \`${commit}\` with \`npm run bench:report\`.
Node ${process.version}. Every number below is computed from decisions the listener made on the clips; definitions at the end.

## How to read this

- **Scripted set (development).** 10 clips, 111 turns, labelled *before* any detector existed — but the heuristic
  rules were then tuned against their misses (steps 2–7). They are a development set: they show the rules do what
  they were built to do, not how well they generalise.
- **Held-out set.** 4 clips, 40 turns, written after step 4 with phrasings no cue lists, and **never tuned on**:
  run for the first time for this report, and no code was changed after seeing it. This is the honest number for
  the heuristic on material it has not seen. Real TV clips (recorded clips, below) are the real test.
- **jev-haiku** (Claude Haiku as the Jev backend) and **Sonnet response cards** run only with \`ANTHROPIC_API_KEY\`;
  recorded clips only with \`DEEPGRAM_API_KEY\` or \`ASSEMBLYAI_API_KEY\`. Without keys those columns say so —
  nothing is estimated.

## Scripted set (development)

${table(dev)}

## Held-out set (never tuned on)

${held ? table(held) : '_not run_'}

### What the held-out set got wrong (the next tuning targets)

${held ? misses(held) : ''}

Read together: the rules that rest on **structure** generalise — counting a question's turns, comparing figures,
the evidence pack, ads, crowd and nods, who is addressed, and the timing (no wrong interruptions, every response
on time). The rules that rest on **vocabulary** do not: a move to a subject the lexicon does not know is not seen
as a move (a transition cue with an unknown subject should open a new line of thought — the clearest fix), and
evasions, whataboutism and attacks in words no cue lists are missed, while an opposition attack on the record was
read as whataboutism. That is the gap the Haiku backend is for, and what real clips should tune next — with a
fresh held-out split.

## Recorded clips (real TV material)

${dev.results.some((r) => r.perClip.some((c) => !/^\d\d-/.test(c.clip))) ? 'Included in the scripted-set columns above where present; see per clip.' : 'None yet. Add yours with `npm run bench:draft -- --audio <file> --id <name>`, label the draft (`bench/clips/README.md`), and they join the bench: transcribed once at broadcast speed through Deepgram or AssemblyAI, cached, aligned to your labels by time, and scored like every other clip.'}

## Per clip

### Scripted set
${perClip(dev)}
### Held-out set
${held ? perClip(held) : ''}
## Definitions

| metric | what is counted |
| --- | --- |
| diarization accuracy | Words in finished utterances attributed to their true speaker after the listener's majority vote over each utterance. "recognizer" is the same count on the raw per-word labels. |
| topic shift P / R | Per labelled turn (cues to Hepta, ads, crowd and nods excluded): a shift predicted (not \`none\`) against a shift labelled. "type right" counts true positives with the same type (natural / follow-up / diversion). |
| diversion P / R | Per turn: any diversion except question-dodged, against the turn's labelled diversion types. "type right": the predicted type is one the label allows. |
| dodged questions | Per labelled question marked dodged: did the listener call that question dodged (matched by where it was asked)? |
| contradictions | Per turn labelled as contradicting an earlier claim of the same speaker or the evidence pack: was a contradiction flagged on it? |
| ads & crowd / nods / addressed | Turns labelled ignore, backchannel, addressed: P / R of the listener's call on them. |
| **wrong interruptions** | Responses decided while a person was mid-clause (not at a clause boundary, not at the end of a sentence). Target 0. |
| responses on time | Turns labelled respond (answer when the turn ends) or cut (may take the floor at a clause boundary) where Hepta answered at an allowed moment. "out of turn": an answer in a turn labelled quiet. "too early": before the turn's last sentence had ended. |
| decision latency | Wall time per chunk: detector plus rules. "detector alone" excludes the rules. Target < 150 ms. |
| response card | Wall time from the decision to respond to the first words on the card. Target < 1.5 s. |
| early insights | Cards shown on half a sentence (provisional). "right": the turn's labels contain that diversion or contradiction. "shown ahead": how long before the sentence ended. |
`;
writeFileSync('bench/REPORT.md', md);
console.log('written: bench/REPORT.md');
