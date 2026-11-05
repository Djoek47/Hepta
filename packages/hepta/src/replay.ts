/**
 * Replaying partial speech, so speculation can be measured instead of felt.
 *
 * Hepta's whole claim is that keeping several acts alive while someone is
 * still talking makes the interface arrive early. That claim has two costs and
 * one hard safety rule, and none of the three can be judged by talking at a
 * microphone:
 *
 *   lead     how many words before the right card is on screen — the benefit
 *   churn    how many times the stage changed act mid-sentence — the cost
 *   early    how many times anything committed before the speaker stopped
 *
 * `early` must be zero. Not low. A commit on a partial utterance is a write
 * the person never finished asking for, and it is the one failure the rest of
 * the contract exists to prevent. Everything else is a tuning question.
 *
 * Recognizers do not simply append words. They revise: "dishes for my" becomes
 * "dishes for Maya" two words later, and a speculator that cannot survive its
 * own transcript changing underneath it will look fine here and flicker live.
 * So the generator below revises on purpose.
 */

import type { Ctx } from '@intermenu/aiuic-core';
import type { Interim, Speculation } from './index.js';
import type { Speculator } from './index.js';

export type Revision = {
  /** Replace this text once the transcript is at least `after` words long. */
  from: string;
  to: string;
  after: number;
};

export type PartialOptions = {
  /** Words per minute, for turning a word index into a plausible timestamp. */
  wpm?: number;
  /** Mid-utterance corrections the recognizer makes as context arrives. */
  revisions?: Revision[];
};

export type Partial = Interim & { words: number; atMs: number };

/** Typical conversational speech. Used only to make the trace legible. */
export const DEFAULT_WPM = 150;

/**
 * A sentence as a recognizer would deliver it: growing prefixes, with any
 * declared revisions applied once enough context has arrived.
 */
export function partials(text: string, opts: PartialOptions = {}): Partial[] {
  const wpm = opts.wpm ?? DEFAULT_WPM;
  const msPerWord = 60_000 / wpm;
  const words = text.trim().split(/\s+/);
  const out: Partial[] = [];

  for (let i = 1; i <= words.length; i++) {
    let prefix = words.slice(0, i).join(' ');
    for (const r of opts.revisions ?? []) {
      // Before `after`, the recognizer is still hearing it wrong.
      if (i < r.after) prefix = prefix.replace(r.to, r.from);
    }
    out.push({
      text: prefix,
      final: i === words.length,
      words: i,
      atMs: Math.round(i * msPerWord),
    });
  }
  return out;
}

export type ReplayCase = {
  text: string;
  /** The act this sentence means. Null when it should route nowhere. */
  act: string | null;
  revisions?: Revision[];
  note?: string;
};

export type Tick = {
  partial: Partial;
  leader: string | null;
  switched: boolean;
  tracks: number;
  /** Status of the run at this tick. Anything past `speculating` before the
   *  final partial is a contract breach, not a tuning problem. */
  status: string | null;
};

export type Trace = {
  case: ReplayCase;
  ticks: Tick[];
  /** Words spoken before the right act took the stage and kept it. null if never. */
  leadWords: number | null;
  leadMs: number | null;
  /** Total words in the sentence. */
  words: number;
  /** Times the stage changed act. */
  switches: number;
  /** Did it end on the right act? */
  endedRight: boolean;
  /** Committed, or left speculating, before the transcript was final. */
  earlyCommit: boolean;
  /**
   * Ended holding an act nobody asked for: when the hold runs out, it commits
   * on silence. Worse than a routing miss, and invisible to EARLY COMMITS,
   * which only looks before the sentence ends. Found by "did Sam do the laundry".
   */
  wrongHold: boolean;
  /** Most tracks alive at once. */
  peakTracks: number;
};

/**
 * Drive one sentence through a speculator and record every tick.
 *
 * `reset` between cases is the caller's job, because forgetting it is a real
 * bug this harness should be able to reproduce.
 */
export function replay(
  spec: Speculator,
  kase: ReplayCase,
  ctx: Ctx,
  opts: PartialOptions = {},
): Trace {
  const seq = partials(kase.text, { ...opts, revisions: kase.revisions ?? opts.revisions });
  const ticks: Tick[] = [];
  let switches = 0;
  let peakTracks = 0;
  let earlyCommit = false;
  let leadWords: number | null = null;
  let leadMs: number | null = null;

  for (const p of seq) {
    const s: Speculation = spec.feed(p, ctx);
    const run = spec.currentRun;
    const status = run ? run.status : null;

    if (s.switched) switches++;
    peakTracks = Math.max(peakTracks, s.tracks.length);

    // The rule. Before the last partial, nothing may have left speculating.
    if (!p.final && status && status !== 'speculating' && status !== 'resolving') {
      earlyCommit = true;
    }

    if (kase.act && s.leader === kase.act) {
      // Only counts if it keeps the stage from here on — an act that leads for
      // one word and loses it has not arrived early, it has flickered.
      if (leadWords === null) { leadWords = p.words; leadMs = p.atMs; }
    } else if (kase.act) {
      leadWords = null; leadMs = null;
    }

    ticks.push({ partial: p, leader: s.leader, switched: s.switched, tracks: s.tracks.length, status });
  }

  const last = ticks[ticks.length - 1];
  return {
    case: kase,
    ticks,
    leadWords,
    leadMs,
    words: seq.length,
    switches,
    endedRight: (last?.leader ?? null) === kase.act,
    earlyCommit,
    wrongHold: !!last && last.status === 'hold' && (last.leader ?? null) !== kase.act,
    peakTracks,
  };
}

export type SpeculationReport = {
  cases: number;
  endedRight: number;
  /** The number that must be zero. */
  earlyCommits: number;
  /** The other number that must be zero. */
  wrongHolds: number;
  /** Mean fraction of the sentence still unsaid when the card was right. */
  meanLeadFraction: number;
  meanLeadMs: number;
  /** Mean act changes per sentence. The flicker budget. */
  meanSwitches: number;
  peakTracks: number;
  traces: Trace[];
};

export function speculationReport(traces: Trace[]): SpeculationReport {
  const withLead = traces.filter((t) => t.leadWords !== null);
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

  return {
    cases: traces.length,
    endedRight: traces.filter((t) => t.endedRight).length,
    earlyCommits: traces.filter((t) => t.earlyCommit).length,
    wrongHolds: traces.filter((t) => t.wrongHold).length,
    meanLeadFraction: withLead.length
      ? sum(withLead.map((t) => 1 - t.leadWords! / t.words)) / withLead.length
      : 0,
    meanLeadMs: withLead.length
      ? sum(withLead.map((t) => (t.ticks[t.ticks.length - 1]!.partial.atMs - t.leadMs!))) / withLead.length
      : 0,
    meanSwitches: traces.length ? sum(traces.map((t) => t.switches)) / traces.length : 0,
    peakTracks: traces.length ? Math.max(...traces.map((t) => t.peakTracks)) : 0,
    traces,
  };
}

export function formatSpeculation(r: SpeculationReport): string {
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  return [
    `cases              ${r.cases}`,
    `ended on the act   ${r.endedRight}/${r.cases}  (${pct(r.endedRight / (r.cases || 1))})`,
    `EARLY COMMITS      ${r.earlyCommits}      <- must be 0`,
    `WRONG HOLDS        ${r.wrongHolds}      <- must be 0: would commit on silence what nobody asked for`,
    ``,
    `card right by      ${pct(r.meanLeadFraction)} of the way in`,
    `time bought        ${Math.round(r.meanLeadMs)}ms before the sentence ended`,
    `stage switches     ${r.meanSwitches.toFixed(2)} per sentence`,
    `peak tracks        ${r.peakTracks} of 7 tongues`,
  ].join('\n');
}

/** One sentence, word by word, with what the stage was showing. */
export function formatTrace(t: Trace): string {
  const lines = [`"${t.case.text}"  -> ${t.case.act ?? 'nothing'}${t.case.note ? '  (' + t.case.note + ')' : ''}`];
  for (const tick of t.ticks) {
    const mark = tick.switched ? '>' : ' ';
    lines.push(
      `  ${mark} ${String(tick.partial.atMs).padStart(5)}ms  ${tick.partial.text.padEnd(46)}` +
      `${(tick.leader ?? '—').padEnd(16)} ${tick.tracks} alive  ${tick.status ?? ''}`,
    );
  }
  if (t.case.act === null) {
    lines.push(t.endedRight ? '  stayed off the stage, as it should' : '  routed somewhere it should not have');
  } else if (t.leadWords !== null) {
    const left = t.words - t.leadWords;
    lines.push(left === 0
      ? '  only right on the last word'
      : `  card was right with ${left} word(s) still to come`);
  } else {
    lines.push('  never settled on the right act');
  }
  return lines.join('\n');
}
