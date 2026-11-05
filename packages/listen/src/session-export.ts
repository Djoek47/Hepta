/**
 * The session as one JSON file: everything heard, decided, shown and said, the
 * operator's marks, and the numbers. This is what tuning works from.
 */
import type { Listener } from './engine.js';

export type MarkKind = 'good' | 'should_have_flagged' | 'false_flag' | 'too_early' | 'too_late';
export const MARKS: MarkKind[] = ['good', 'should_have_flagged', 'false_flag', 'too_early', 'too_late'];
export type Mark = { target: string; on: 'decision' | 'insight' | 'response' | 'utterance'; mark: MarkKind; note?: string; at: string };

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : null; };
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]! : null; };

export function exportSession(l: Listener, meta: Record<string, unknown>, marks: Mark[] = []) {
  const finals = l.decisions.filter((d) => d.final && d.trigger !== 'turn-end' && d.trigger !== 'operator');
  const firsts = l.responses.map((r) => r.firstMs).filter((x): x is number => x !== undefined);
  const totals = l.responses.map((r) => r.totalMs).filter((x): x is number => x !== undefined);
  return {
    format: 'hepta-listen-session/1',
    exportedAt: new Date().toISOString(),
    meta: { ...meta, mode: l.mode, backend: l.detector.name },
    speakers: l.speakers.list(),
    transcript: finals.map((d) => ({ utteranceId: d.utteranceId, speaker: d.speaker, atMs: d.atMs, text: d.text, ...(d.ignored ? { ignored: d.ignored } : {}) })),
    decisions: l.decisions,
    insights: l.insights,
    responses: l.responses,
    threads: l.memory.threads,
    questions: l.memory.questions,
    claims: l.memory.claims,
    stance: l.timing.stance(),
    stanceReplies: l.timing.stanceLog,
    marks,
    stats: {
      decisions: l.decisions.length,
      decisionLatencyMs: { median: med(l.decisions.map((d) => d.latencyMs)), p95: p95(l.decisions.map((d) => d.latencyMs)) },
      detectorMs: { median: med(l.decisions.map((d) => d.detectorMs)), p95: p95(l.decisions.map((d) => d.detectorMs)) },
      responseFirstMs: { median: med(firsts), p95: p95(firsts) },
      responseTotalMs: { median: med(totals), p95: p95(totals) },
      marks: Object.fromEntries(MARKS.map((k) => [k, marks.filter((m) => m.mark === k).length])),
    },
  };
}
