/**
 * The Jev backend: the same Detector, asking a typed-decision model.
 *
 * Every judgment the rules need is put as a typed question over an answer
 * space declared here — a Choice, a Noul — through the JevTransport ported
 * from aiuic-resolve. Any transport answers: Claude Haiku (haiku.ts), the
 * hosted Jev service (`httpTransport` from aiuic-resolve), or a fake in tests.
 *
 * What stays local, always: numbers and units (a model does not read a
 * figure better than the grammar does), the evidence pack's arithmetic, and
 * the fallback — if the answer is late or fails, the local judgment stands.
 * A detector that can hang the listener is worse than one that is wrong.
 */
import type { JevAnswer, JevQuestion, JevResponse, JevTransport } from '@intermenu/aiuic-resolve';
import { HeuristicDetector } from './heuristic.js';
import { clock } from './text.js';
import type { DetectState, Detector, DiversionType, Heard, Judgment, Reading, ShiftType } from './types.js';

export const SHIFT_OPTIONS = ['none', 'follow_up', 'natural', 'diversion'] as const;
export const DIVERSION_OPTIONS = ['none', 'deflection', 'whataboutism', 'ad_hominem', 'moving_goalposts', 'changed_claim'] as const;
export const IGNORE_OPTIONS = ['conversation', 'ad', 'crowd', 'backchannel'] as const;

export type JevDetectorOptions = {
  transport: JevTransport;
  /** Passed through as JevRequest.model. */
  model?: string;
  name?: string;
  /** Beyond this the local judgment is used. */
  timeoutMs?: number;
  /** Ask on partials too ('every'), only at clause boundaries ('boundary'), or only on finals ('final'). */
  partials?: 'every' | 'boundary' | 'final';
  local?: HeuristicDetector;
};

export class JevDetector implements Detector {
  readonly name: string;
  readonly local = false;
  private readonly heuristic: HeuristicDetector;
  /** Calls answered, calls that fell back, and why. */
  readonly stats = { asked: 0, answered: 0, fellBack: 0, lastError: '' };

  constructor(private readonly opts: JevDetectorOptions) {
    this.name = opts.name ?? 'jev';
    this.heuristic = opts.local ?? new HeuristicDetector();
  }

  async detect(h: Heard, st: DetectState, signal?: AbortSignal): Promise<Judgment> {
    const base = this.heuristic.detect(h, st);
    if (base.ignore === 'crowd') return base; // nothing a model can add to applause
    const when = this.opts.partials ?? 'every';
    if (!h.final && (when === 'final' || (when === 'boundary' && !h.boundary))) return base;

    const questions = questionsFor(h, st, base);
    const state = compactState(h, st, base);
    this.stats.asked++;
    let res: JevResponse;
    try {
      res = await withTimeout(this.opts.transport({ model: this.opts.model ?? 'jev-latest', state, questions }, signal),
        this.opts.timeoutMs ?? 2500);
    } catch (err) {
      this.stats.fellBack++;
      this.stats.lastError = String((err as Error)?.message ?? err);
      return base;
    }
    this.stats.answered++;
    return merge(base, res.answers, st, h);
  }
}

// ------------------------------------------------------------------ questions

export function questionsFor(h: Heard, st: DetectState, base: Judgment): JevQuestion[] {
  const qs: JevQuestion[] = [
    { type: 'choice', key: 'shift', question: 'How did the subject move from onAir to now?', criteria: crit(SHIFT_OPTIONS) },
    { type: 'choice', key: 'diversion', question: 'Which diversion is this, if any?', criteria: crit(DIVERSION_OPTIONS) },
    { type: 'noul', key: 'addressed', question: 'Is this addressed to Hepta?' },
    { type: 'choice', key: 'ignore', question: 'Is this part of the conversation?', criteria: crit(IGNORE_OPTIONS) },
  ];
  if (!h.final) return qs;
  const open = st.questions.filter((q) => q.status === 'open' && q.by !== h.speaker && (q.to === h.speaker || q.to === null));
  if (open.length > 0) {
    qs.push({ type: 'choice', key: 'answers', question: 'Which open question does this answer?',
      criteria: { none: 'none of them', ...Object.fromEntries(open.map((q) => [q.id, q.text])) } });
  }
  const mine = st.claims.filter((c) => c.speaker === h.speaker).slice(-4);
  const ev = st.evidence.slice(0, 6);
  if (mine.length + ev.length > 0) {
    qs.push({ type: 'choice', key: 'contradicts', question: 'Which earlier claim by this speaker, or evidence item, does this contradict?',
      criteria: { none: 'none', ...Object.fromEntries(mine.map((c) => [c.id, c.text])), ...Object.fromEntries(ev.map((e) => [e.id, e.text])) } });
  }
  const topics = [...new Set([st.current.topic, base.topic, ...st.threads.slice(0, 5).map((t) => t.topic)].filter((t): t is string => !!t))];
  if (topics.length > 1) qs.push({ type: 'choice', key: 'topic', question: 'What is the subject of now?', criteria: Object.fromEntries(topics.map((t) => [t, t])) });
  return qs;
}

function crit(opts: readonly string[]): Record<string, string> {
  return Object.fromEntries(opts.map((o) => [o, o]));
}

/** The conversation, as short as it can be and still be judged. */
export function compactState(h: Heard, st: DetectState, base: Judgment): Record<string, unknown> {
  const name = (id: string | null) => {
    if (!id) return 'everyone';
    const s = st.speakers.find((x) => x.id === id);
    return s?.name ? `${id} (${s.name})` : id;
  };
  return {
    mode: st.mode,
    speakers: st.speakers.map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}), ...(s.role ? { role: s.role } : {}) })),
    recent: st.turns.filter((t) => !t.ignored).slice(-6).map((t) => [t.speaker, clock(t.startMs), t.text.slice(0, 180)]),
    onAir: st.current.topic,
    openQuestions: st.questions.filter((q) => q.status === 'open').slice(-4)
      .map((q) => ({ id: q.id, by: q.by, to: name(q.to), text: q.text, asked: clock(q.askedMs), turnsSince: q.turnsSince })),
    claims: st.claims.slice(-6).map((c) => ({ id: c.id, speaker: c.speaker, text: c.text.slice(0, 160), at: clock(c.atMs) })),
    evidence: st.evidence.slice(0, 6).map((e) => ({ id: e.id, text: e.text + (e.source ? ` (${e.source})` : '') })),
    ...(st.stance ? { stance: st.stance.position } : {}),
    localGuess: { topic: base.topic, shift: base.shiftType, diversion: base.diversion?.type ?? 'none' },
    now: { speaker: name(h.speaker), text: h.text, final: h.final },
  };
}

// --------------------------------------------------------------------- merging

function dist(a: JevAnswer | undefined): Record<string, number> {
  if (!a) return {};
  if (a.probabilities && !Array.isArray(a.probabilities)) return a.probabilities;
  if (a.choice) return { [a.choice]: a.confidence ?? 1 };
  return {};
}

function top(d: Record<string, number>, allowed: readonly string[]): [string, number] | null {
  const best = Object.entries(d).filter(([k]) => allowed.includes(k)).sort((a, b) => b[1] - a[1])[0];
  return best ?? null;
}

/** Fold the model's answers into the local judgment. Local extraction stays; the model judges. */
export function merge(base: Judgment, answers: JevAnswer[], st: DetectState, h: Heard): Judgment {
  const by = new Map(answers.map((a) => [a.key, a]));
  const out: Judgment = { ...base };

  const ign = top(dist(by.get('ignore')), IGNORE_OPTIONS);
  if (ign && ign[0] !== 'conversation' && ign[1] >= 0.6) {
    return { topic: null, topicKeys: [], shiftType: 'none', addressedToHepta: false, ignore: ign[0] as Judgment['ignore'],
      readings: [{ label: `ignore:${ign[0]}`, p: round(ign[1]) }], confidence: ign[1] };
  }
  if (base.ignore && ign && ign[0] === 'conversation' && ign[1] >= 0.7) delete out.ignore;

  const addr = by.get('addressed');
  if (addr && typeof addr.noul === 'number') out.addressedToHepta = base.addressedToHepta || addr.noul >= 0.5;

  const topicAns = top(dist(by.get('topic')), Object.keys(dist(by.get('topic'))));
  if (topicAns && topicAns[1] >= 0.5) {
    out.topic = topicAns[0];
    const t = st.threads.find((x) => x.topic === topicAns[0]);
    if (t) out.topicKeys = t.keys;
  }

  const shiftD = dist(by.get('shift'));
  const divD = dist(by.get('diversion'));
  const s = top(shiftD, SHIFT_OPTIONS);
  const d = top(divD, DIVERSION_OPTIONS);
  if (s) out.shiftType = s[0] as ShiftType;

  // The diversion the model names. question_dodged is never its call: that is a count of turns.
  delete out.diversion;
  if (d && d[0] !== 'none' && d[1] >= 0.5) {
    const type = d[0] as DiversionType;
    const div: NonNullable<Judgment['diversion']> = { type, confidence: round(d[1]), why: 'jev' };
    const q = st.questions.filter((x) => x.status === 'open' && x.to === h.speaker).pop();
    if (type === 'deflection' && q) div.questionId = q.id;
    const claimId = base.claim?.contradicts?.claimId ?? base.diversion?.claimId;
    if ((type === 'changed_claim' || type === 'moving_goalposts') && claimId) div.claimId = claimId;
    out.diversion = div;
    if (type === 'deflection' || type === 'whataboutism' || type === 'ad_hominem') out.shiftType = 'diversion';
  } else if (out.shiftType === 'diversion') {
    out.shiftType = base.shiftType === 'diversion' ? 'follow_up' : base.shiftType;
  }

  const ans = by.get('answers');
  if (ans) {
    const a = top(dist(ans), Object.keys(dist(ans)));
    if (a && a[0] !== 'none' && a[1] >= 0.5 && st.questions.some((q) => q.id === a[0])) out.answers = a[0];
    else delete out.answers;
  }

  const con = by.get('contradicts');
  if (con) {
    const c = top(dist(con), Object.keys(dist(con)));
    if (c && c[0] !== 'none' && c[1] >= 0.5) {
      const claim = st.claims.find((x) => x.id === c[0]);
      const ev = st.evidence.find((x) => x.id === c[0]);
      const kind = ev ? 'evidence' as const : claim?.kind === 'commitment' ? 'moving_goalposts' as const : 'changed_claim' as const;
      const contradicts = ev ? { evidenceId: ev.id, kind } : claim ? { claimId: claim.id, kind } : undefined;
      if (contradicts) {
        out.claim = out.claim
          ? { ...out.claim, contradicts }
          : { subject: ev?.subject ?? claim?.subject ?? 'claim', keys: ev?.keys ?? claim?.keys ?? [], kind: 'fact', text: h.text, contradicts };
      }
    } else if (c && c[0] === 'none' && c[1] >= 0.7 && out.claim?.contradicts) {
      const { contradicts: _drop, ...rest } = out.claim;
      out.claim = rest;
    }
  }

  out.readings = readingsOf(shiftD, divD);
  out.confidence = round(Math.max(s?.[1] ?? 0, d?.[1] ?? 0, out.readings[0]?.p ?? 0));
  return out;
}

/** Up to three readings from the shift and diversion distributions. */
function readingsOf(shiftD: Record<string, number>, divD: Record<string, number>): Reading[] {
  const out: Record<string, number> = {};
  const divs = Object.entries(divD).filter(([k]) => k !== 'none');
  const pDivTotal = divs.reduce((a, [, p]) => a + p, 0);
  for (const [k, p] of Object.entries(shiftD)) {
    if (k === 'diversion') continue;
    out[k] = (out[k] ?? 0) + p;
  }
  for (const [k, p] of divs) out[`diversion:${k}`] = Math.max(p, (shiftD.diversion ?? 0) * (pDivTotal ? p / pDivTotal : 0));
  const total = Object.values(out).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(out).map(([label, p]) => ({ label, p: round(p / total) })).sort((a, b) => b.p - a.p).slice(0, 3);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`jev: no answer in ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
