/**
 * Replaying conversations through the lines of thought, and scoring where it
 * cut in. The companion to replay.ts, which scores the foreground.
 */

import { Lines, type Decision } from './lines.js';
import type { DebateCase } from '../suites/debate.js';

export type DebateTrace = {
  case: DebateCase;
  got: 'cut' | 'end' | 'quiet';
  /** The partial it cut in on, if it did. */
  cutAt: string | null;
  cutKind: 'boundary' | 'urgent' | null;
  right: boolean;
};

export function replayDebate(c: DebateCase, gap = 250): DebateTrace {
  const l = new Lines({ bluntness: c.bluntness ?? 0.5 });
  let t = 0;
  for (const s of c.before) {
    const words = s.split(' ');
    words.forEach((_, i) => l.hear({ text: words.slice(0, i + 1).join(' '), final: i === words.length - 1, atMs: (t += gap) }));
  }
  for (const st of c.stances ?? []) {
    l.hold(st.topic, st.keys, { position: st.position, evidence: [], confidence: st.confidence, against: st.against }, t);
  }
  t += 60_000;

  const ctx = { leader: c.leader?.act ?? null, leaderRadius: c.leader?.radius ?? null };
  const words = c.now.split(' ');
  let got: DebateTrace['got'] = 'quiet';
  let cutAt: string | null = null;
  let cutKind: DebateTrace['cutKind'] = null;

  for (let i = 0; i < words.length; i++) {
    const text = words.slice(0, i + 1).join(' ');
    const d: Decision = l.hear({ text, final: i === words.length - 1, atMs: (t += gap) }, ctx);
    if (d.kind === 'interrupt') { got = 'cut'; cutAt = text; cutKind = d.at; break; }
    if (d.kind === 'queue') got = 'end';
  }
  return { case: c, got, cutAt, cutKind, right: got === c.expect };
}

export type DebateReport = {
  cases: number;
  right: number;
  /** Cut in when it should have waited or stayed quiet. The one that gets it turned off. */
  wrongCuts: number;
  /** Should have cut in and did not. */
  missedCuts: number;
  /** Raised something when it should have said nothing. */
  spoke: number;
  traces: DebateTrace[];
};

export function debateReport(traces: DebateTrace[]): DebateReport {
  return {
    cases: traces.length,
    right: traces.filter((t) => t.right).length,
    wrongCuts: traces.filter((t) => t.got === 'cut' && t.case.expect !== 'cut').length,
    missedCuts: traces.filter((t) => t.case.expect === 'cut' && t.got !== 'cut').length,
    spoke: traces.filter((t) => t.case.expect === 'quiet' && t.got !== 'quiet').length,
    traces,
  };
}

export function formatDebate(r: DebateReport): string {
  const lines = [
    `cases              ${r.cases}`,
    `right              ${r.right}/${r.cases}`,
    `WRONG CUTS         ${r.wrongCuts}      <- the one that gets it turned off`,
    `missed cuts        ${r.missedCuts}`,
    `spoke out of turn  ${r.spoke}`,
    '',
  ];
  for (const t of r.traces) {
    const mark = t.right ? ' ' : 'x';
    const where = t.cutAt ? `  cut at "${t.cutAt}" (${t.cutKind})` : '';
    lines.push(`  ${mark} ${t.case.name.padEnd(52)} want ${t.case.expect.padEnd(5)} got ${t.got}${where}`);
  }
  return lines.join('\n');
}
