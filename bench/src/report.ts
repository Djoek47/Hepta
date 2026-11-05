/**
 * The bench report: one column per backend, every row a number computed from
 * decisions the listener made. Printed, and written as JSON and Markdown.
 */
import { median, pct, precision, recall, type Metrics, type PR } from './metrics.js';

export type BackendResult = { backend: string; metrics: Metrics; perClip: { clip: string; metrics: Metrics }[]; note?: string };

const f2 = (n: number | null) => (n === null ? '—' : n.toFixed(2));
const p1 = (n: number | null) => (n === null ? '—' : (n * 100).toFixed(1) + '%');
const ms = (n: number | null) => (n === null ? '—' : n < 10 ? n.toFixed(2) + ' ms' : Math.round(n) + ' ms');
const prs = (x: PR) => `${f2(precision(x))} / ${f2(recall(x))}`;
const counts = (x: PR) => `tp ${x.tp} fp ${x.fp} fn ${x.fn}`;

export type Row = { label: string; cells: string[]; note?: string };

export function rows(results: BackendResult[]): Row[] {
  const r = (label: string, fn: (m: Metrics) => string, note?: string): Row => ({ label, cells: results.map((x) => fn(x.metrics)), ...(note ? { note } : {}) });
  return [
    r('diarization accuracy (words)', (m) => `${p1(m.diarization.words ? m.diarization.engine / m.diarization.words : null)} (recognizer ${p1(m.diarization.words ? m.diarization.raw / m.diarization.words : null)})`),
    r('topic shift P / R', (m) => prs(m.shift)),
    r('  shift type right', (m) => `${m.shift.typeRight}/${m.shift.tp}`),
    r('diversion P / R', (m) => prs(m.diversion)),
    r('  diversion type right', (m) => `${m.diversion.typeRight}/${m.diversion.tp}`),
    r('dodged questions P / R', (m) => `${prs(m.dodged)}  (${counts(m.dodged)})`),
    r('contradictions P / R', (m) => `${prs(m.contradiction)}  (${counts(m.contradiction)})`),
    r('ads & crowd ignored P / R', (m) => prs(m.ignore)),
    r('nods are not turns P / R', (m) => prs(m.nods)),
    r('addressed to Hepta P / R', (m) => prs(m.addressed)),
    r('WRONG INTERRUPTIONS', (m) => String(m.respond.wrongInterruptions), 'target 0: took the floor mid-clause'),
    r('responses on time', (m) => `${m.respond.hit}/${m.respond.expected}`),
    r('  spoke out of turn / too early', (m) => `${m.respond.outOfTurn} / ${m.respond.tooEarly}`),
    r('decision latency median / p95', (m) => `${ms(median(m.latencyMs))} / ${ms(pct(m.latencyMs, 95))}`, 'target < 150 ms per decision'),
    r('  detector alone median / p95', (m) => `${ms(median(m.detectorMs))} / ${ms(pct(m.detectorMs, 95))}`),
    r('response card median / p95', (m) => m.responseMs.length ? `${ms(median(m.responseMs))} / ${ms(pct(m.responseMs, 95))}` : '—', 'target < 1.5 s to the card'),
    r('early insights right', (m) => m.early.shown ? `${m.early.right}/${m.early.shown} (${p1(m.early.right / m.early.shown)})` : '—', 'provisional cards on half a sentence that the labels bear out'),
    r('  confirmed / retracted', (m) => m.early.shown ? `${m.early.confirmed} / ${m.early.retracted}` : '—'),
    r('  shown ahead of the sentence end', (m) => m.early.leadMs.length ? ms(median(m.early.leadMs)) + ' median' : '—'),
  ];
}

export function formatReport(results: BackendResult[], title: string): string {
  const rs = rows(results);
  const w0 = Math.max(...rs.map((r) => r.label.length)) + 2;
  const widths = results.map((x, i) => Math.max(x.backend.length, ...rs.map((r) => r.cells[i]!.length)) + 3);
  const line = (a: string, cells: string[], note = '') => a.padEnd(w0) + cells.map((c, i) => c.padEnd(widths[i]!)).join('') + (note ? `  ${note}` : '');
  const out = [title, '', line('', results.map((x) => x.backend)), line('', results.map((_, i) => '-'.repeat(widths[i]! - 3)))];
  for (const r of rs) out.push(line(r.label, r.cells, r.note));
  for (const x of results) if (x.note) out.push('', `${x.backend}: ${x.note}`);
  return out.join('\n');
}

export function formatMarkdown(results: BackendResult[], title: string): string {
  const rs = rows(results);
  const out = [`# ${title}`, '', `| | ${results.map((x) => x.backend).join(' | ')} | |`, `|---|${results.map(() => '---').join('|')}|---|`];
  for (const r of rs) out.push(`| ${r.label.trim()} | ${r.cells.join(' | ')} | ${r.note ?? ''} |`);
  for (const x of results) if (x.note) out.push('', `**${x.backend}:** ${x.note}`);
  out.push('', '## Per clip', '');
  for (const x of results) {
    out.push(`### ${x.backend}`, '', '| clip | shift P/R | diversion P/R | dodges P/R | contradictions P/R | wrong interruptions | responses |', '|---|---|---|---|---|---|---|');
    for (const c of x.perClip) {
      const m = c.metrics;
      out.push(`| ${c.clip} | ${prs(m.shift)} | ${prs(m.diversion)} | ${prs(m.dodged)} | ${prs(m.contradiction)} | ${m.respond.wrongInterruptions} | ${m.respond.hit}/${m.respond.expected} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
