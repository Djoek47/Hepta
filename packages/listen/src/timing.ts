/**
 * When Hepta speaks. Four states, decided on every chunk:
 *
 *   listen    nothing to say
 *   note      something happened and is on a card; nothing to say about it
 *   ready     a point is waiting — for a clause boundary, the end of the turn, or a cue
 *   respond   now: a boundary was reached with a point worth the floor, the turn ended
 *             with a point or a question to Hepta, or the moderator asked
 *
 * In conversation and debate the rules are the ported Lines rules, unchanged:
 * Hepta's points become Lines threads, and Lines decides — cut in only at a
 * clause boundary unless urgent, push once per disagreement, concede below 0.4
 * on a real reason, nods are not turns, a point queued on half a sentence is
 * rechecked on the whole. Nothing a listener can raise is worth cutting a
 * clause for, so no urge here reaches Lines' urgent level: Hepta never takes
 * the floor mid-clause.
 *
 * In a panel Hepta does not cut in at all. Its points wait, shown as READY,
 * until the moderator cues it or someone puts a question to it — unless it is
 * set to debate, which is the debater mode.
 *
 * A point that waits for "the end of the turn" waits for the turn, not the
 * sentence: a recognizer's final marks a pause, and people go on after pauses.
 * So it fires once the speaker has been quiet for `turnEndMs`.
 */
import { Lines, type Decision as LinesDecision, type Detector as LinesDetector, type Reply, type Thread } from '@intermenu/hepta/lines';
import type { Heard, Judgment, Mode, RespondState, StanceSeed } from './types.js';

/** Below Lines' urgent level (0.9): a listener never has a reason to break a clause. */
export const URGE_CAP = 0.89;
export const TURN_END_MS = 700;

export type PointReason = 'contradiction' | 'against-stance' | 'question' | 'return';

/** Something Hepta could say, live on this chunk. */
export type Point = {
  key: string;
  reason: PointReason;
  urge: number;
  say: string;
  /** For a stance point: which disagreement (one push each). */
  disagreement?: string;
};

export type TimingDecision = {
  state: RespondState;
  why: string;
  /** The point it is raising (respond) or holding (ready). */
  point?: Point;
  /** Respond only once the speaker's turn has ended. */
  atTurnEnd?: boolean;
  /** Lines' own call on the floor while Hepta is speaking. */
  floor?: 'keep' | 'yield';
};

export type TimingOptions = { bluntness?: number; stance?: StanceSeed; turnEndMs?: number };

export class Timing {
  private readonly lines: Lines;
  /** Points live on the chunk being decided, by Lines thread id. */
  private live = new Map<string, Point>();
  private readonly threadOf = new Map<string, Thread>();
  private readonly pointOf = new Map<string, Point>();
  /** Panel: points waiting for a cue. */
  readonly waiting: Point[] = [];
  /** Hepta has the floor (speaking its answer aloud). */
  speaking = false;
  readonly turnEndMs: number;
  /** The stance thread last raised, whose disagreement the next reasons answer, and the sentence that raised it. */
  private raisedStance: Thread | null = null;
  private raisedBy: string | null = null;
  readonly stanceLog: { atMs: number; reply: Reply; text: string; confidence: number }[] = [];

  constructor(readonly mode: Mode, private readonly opts: TimingOptions = {}) {
    const listenDetector: LinesDetector = (_p, t) => {
      const pt = this.live.get(t.id);
      return pt ? { thread: t, urge: Math.min(URGE_CAP, pt.urge), reason: pt.reason, say: pt.say } : null;
    };
    this.lines = new Lines({ bluntness: opts.bluntness ?? (mode === 'debater' ? 0.6 : 0.5), detectors: [listenDetector] });
    this.turnEndMs = opts.turnEndMs ?? TURN_END_MS;
  }

  /** Lines' threshold for cutting in at a boundary. */
  get threshold(): number {
    return this.lines.threshold;
  }

  /** The Lines thread behind a point: one per key; a stance point is a stance thread, one per disagreement. */
  private thread(p: Point, atMs: number): Thread {
    let t = this.threadOf.get(p.key);
    if (!t) {
      const s = this.opts.stance;
      t = p.reason === 'against-stance' && s
        ? this.lines.hold(s.topic, s.keys, { position: s.position, evidence: [...s.evidence], confidence: s.confidence, against: ['oppose'] }, atMs)
        : this.lines.note({ kind: p.reason === 'question' ? 'question' : p.reason === 'contradiction' ? 'claim' : 'aside', topic: p.key, keys: [], said: { text: p.say, atMs } });
      this.threadOf.set(p.key, t);
    }
    this.pointOf.set(t.id, p);
    return t;
  }

  /** The stance as it stands: still held, conceded, or overridden. */
  stance(): { confidence: number; conceded: boolean; overridden: boolean; pushes: number } | null {
    const t = this.raisedStance;
    if (!t?.stance) return null;
    return { confidence: t.stance.confidence, conceded: t.stance.conceded, overridden: t.stance.overridden, pushes: t.stance.pushes };
  }

  /**
   * After Hepta has pushed a stance, what the other side says next is a reply to
   * it. A reason lowers the confidence; below 0.4 it concedes (the Lines rule).
   */
  reply(h: Heard, isOpponent: boolean): Reply | null {
    const t = this.raisedStance;
    // The sentence that earned the push is not a reply to it.
    if (!t?.stance || !h.final || !isOpponent || t.resolved || h.utteranceId === this.raisedBy) return null;
    const r = this.lines.reply(t.id, h.text);
    this.stanceLog.push({ atMs: h.atMs, reply: r, text: h.text, confidence: t.stance.confidence });
    return r;
  }

  decide(h: Heard, j: Judgment, points: Point[], noted: boolean): TimingDecision {
    if (this.speaking) {
      const d = this.lines.hear({ text: h.text, final: h.final, atMs: h.atMs, boundary: h.boundary }, { leader: null, leaderRadius: null, speaking: true });
      if (d.kind === 'yield') { this.speaking = false; return { state: 'listen', why: `they took the turn (${d.why})`, floor: 'yield' }; }
      return { state: 'listen', why: 'a nod while Hepta speaks: keep going', floor: 'keep' };
    }
    if (j.ignore) return { state: 'listen', why: j.ignore === 'backchannel' ? 'a nod, not a turn' : `not the conversation (${j.ignore})` };

    if (this.mode === 'panel') return this.panel(h, j, points, noted);

    // Conversation and debate: Lines decides.
    this.live = new Map();
    for (const p of points) this.live.set(this.thread(p, h.atMs).id, p);
    const d: LinesDecision = this.lines.hear({ text: h.text, final: h.final, atMs: h.atMs, boundary: h.boundary }, { leader: null, leaderRadius: null });
    if (d.kind === 'interrupt') {
      const p = this.pointOf.get(d.urge.thread.id);
      if (d.urge.thread.stance) { this.raisedStance = d.urge.thread; this.raisedBy = h.utteranceId; }
      return { state: 'respond', why: d.at === 'boundary' ? `a clause ended and the point is worth the floor (${d.urge.urge.toFixed(2)} ≥ ${this.threshold.toFixed(2)})` : 'urgent', ...(p ? { point: p } : {}) };
    }
    if (d.kind === 'queue') {
      const p = this.pointOf.get(d.urge.thread.id);
      if (d.urge.thread.stance) { this.raisedStance = d.urge.thread; this.raisedBy = h.utteranceId; }
      return { state: 'ready', why: 'the sentence ended; waiting for the end of the turn', atTurnEnd: true, ...(p ? { point: p } : {}) };
    }
    const pending = this.lines.pending;
    if (pending) {
      const p = this.pointOf.get(pending.thread.id);
      return { state: 'ready', why: `holding a point (${pending.urge.toFixed(2)}) for a clause boundary or the end of the turn`, ...(p ? { point: p } : {}) };
    }
    return { state: noted ? 'note' : 'listen', why: noted ? 'noted on a card' : '' };
  }

  private panel(h: Heard, j: Judgment, points: Point[], noted: boolean): TimingDecision {
    for (const p of points) if (p.reason !== 'question' && !this.waiting.some((w) => w.key === p.key)) this.waiting.push(p);
    const asked = points.find((p) => p.reason === 'question');
    if (asked) {
      return h.final
        ? { state: 'ready', why: 'a cue to Hepta; answering when the turn ends', atTurnEnd: true, point: asked }
        : { state: 'ready', why: 'a cue to Hepta; waiting for the end of the sentence', point: asked };
    }
    if (noted) return { state: 'note', why: this.waiting.length ? `noted; ${this.waiting.length} point(s) waiting for a cue` : 'noted on a card' };
    if (this.waiting.length) return { state: 'ready', why: `${this.waiting.length} point(s) waiting for the moderator's cue` };
    return { state: 'listen', why: '' };
  }

  /** The panel's waiting points have been said. */
  spent(): Point[] {
    return this.waiting.splice(0);
  }
}

/** The points a judgment gives Hepta, by mode. Insights are always shown; points are what it would say. */
export function pointsOf(mode: Mode, h: Heard, j: Judgment, ctx: { stanceKeys?: string[]; rel?: number; mentionsChallenge: boolean }): Point[] {
  const out: Point[] = [];
  if (j.ignore) return out;
  if (j.addressedToHepta || ctx.mentionsChallenge) {
    out.push({ key: `ask:${h.utteranceId}`, reason: 'question', urge: 0.6, say: h.text });
  }
  const c = j.claim?.contradicts;
  if (j.diversion?.type === 'changed_claim' && j.diversion.claimId && mode !== 'panel') {
    out.push({ key: `claim:${j.diversion.claimId}`, reason: 'contradiction', urge: 0.55 + (ctx.rel ?? 0.4) / 2, say: j.diversion.why });
  }
  if (c?.evidenceId) {
    const onStance = mode === 'debater' && (ctx.stanceKeys ?? []).some((k) => (j.claim?.keys ?? []).includes(k) || h.text.toLowerCase().includes(k));
    if (onStance) out.push({ key: `stance:${c.evidenceId}`, reason: 'against-stance', urge: 0.83, say: j.claim?.text ?? h.text, disagreement: c.evidenceId });
    else out.push({ key: `ev:${c.evidenceId}:${h.speaker}`, reason: 'contradiction', urge: mode === 'conversation' ? 0.7 : 0.5, say: j.claim?.text ?? h.text });
  }
  if (mode === 'panel' && j.diversion) {
    out.push({ key: `div:${j.diversion.type}:${h.utteranceId}`, reason: 'return', urge: 0.5, say: j.diversion.why });
  }
  return out;
}
