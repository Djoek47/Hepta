/**
 * The listener. Every chunk a recognizer delivers goes through here, in
 * order: who said it, whether a clause just ended, what the detector makes of
 * it, what that changes in the conversation's memory, and whether Hepta should
 * say anything. One JevDecision comes out per chunk.
 *
 * The detector is the swappable part. Everything else here is rules, and the
 * rules do not change when the detector gets better.
 */
import { atBoundary, BREATH_MS } from './boundary.js';
import {
  diversionCard, dodgedCard, evidenceCard, quoteOf, quoteOfClaim, quoteOfQuestion, shiftCard, type Insight, type InsightKind,
} from './insights.js';
import { Memory, type Committed } from './memory.js';
import { SpeakerTracker } from './speakers.js';
import { clock as clockOf } from './text.js';
import type {
  Detector, EvidenceItem, Heard, JevDecision, Judgment, Mode, RespondState, SpeakerRole, StanceSeed, SttChunk,
} from './types.js';

export type ListenerOptions = {
  mode: Mode;
  detector: Detector;
  evidence?: EvidenceItem[];
  stance?: StanceSeed;
  breathMs?: number;
  /** A question unanswered after this many of the addressee's turns is dodged. Default 2. */
  dodgeTurns?: number;
  halfLifeMs?: number;
  /** Wall clock in ms, for latency. performance.now by default. */
  clock?: () => number;
};

export type ListenEvent =
  | { type: 'heard'; heard: Heard }
  | { type: 'decision'; decision: JevDecision; committed?: Committed }
  | { type: 'insight'; insight: Insight };

export class Listener {
  readonly speakers = new SpeakerTracker();
  readonly memory: Memory;
  readonly decisions: JevDecision[] = [];
  readonly insights: Insight[] = [];
  private insightSeq = 0;
  readonly mode: Mode;
  private readonly fns = new Set<(e: ListenEvent) => void>();
  private readonly clock: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly opts: ListenerOptions) {
    this.mode = opts.mode;
    this.clock = opts.clock ?? (() => performance.now());
    this.memory = new Memory(opts.halfLifeMs, opts.dodgeTurns ?? 2);
  }

  get detector(): Detector {
    return this.opts.detector;
  }

  on(fn: (e: ListenEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  private emit(e: ListenEvent): void {
    for (const fn of this.fns) fn(e);
  }

  /** Name a speaker, as an operator would. */
  name(id: string, name?: string, role?: SpeakerRole): void {
    this.speakers.name(id, name, role);
  }

  /** Chunks are decided in the order they arrive, whatever the detector's latency. */
  hear(chunk: SttChunk): Promise<JevDecision> {
    const next = this.queue.then(() => this.decide(chunk));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async decide(chunk: SttChunk): Promise<JevDecision> {
    const t0 = this.clock();
    const speaker = this.speakers.resolve(chunk);
    const heard: Heard = {
      id: `h${++this.seq}`, utteranceId: chunk.utteranceId, speaker, text: chunk.text, final: chunk.final,
      startMs: chunk.startMs, endMs: chunk.endMs, atMs: chunk.heardToMs,
      boundary: atBoundary(chunk, this.opts.breathMs ?? BREATH_MS), words: chunk.words,
      ...(chunk.event ? { event: chunk.event } : {}),
    };
    this.emit({ type: 'heard', heard });

    this.memory.bindNames(this.speakers.list());
    const state = this.memory.snapshot(this.mode, this.speakers.list(), heard.atMs, this.opts.evidence ?? [], this.opts.stance);
    const d0 = this.clock();
    const j = await this.opts.detector.detect(heard, state);
    const detectorMs = this.clock() - d0;

    const committed = heard.final ? this.memory.commit(heard, j) : undefined;
    if (heard.final) this.speakers.heard(speaker, j.ignore);
    const respondState = this.timing(heard, j, committed);

    const decision: JevDecision = {
      id: `d${this.seq}`, heardId: heard.id, utteranceId: heard.utteranceId, final: heard.final,
      speaker, text: heard.text, atMs: heard.atMs,
      topic: j.topic, shiftType: j.shiftType, shiftFrom: state.current.topic,
      addressedToHepta: j.addressedToHepta, respondState, confidence: j.confidence,
      latencyMs: 0, detectorMs, backend: this.opts.detector.name, provisional: !heard.final,
      boundary: heard.boundary, readings: j.readings,
      ...(j.ignore ? { ignored: j.ignore } : {}),
      ...(j.claim ? { claim: j.claim } : {}),
      ...(j.answers ? { answers: j.answers } : {}),
      ...(committed?.asked ? { questionId: committed.asked.id } : committed?.reasked ? { questionId: committed.reasked.id } : {}),
      ...(j.diversion ? { diversion: { type: j.diversion.type, confidence: j.diversion.confidence, quotes: [], why: j.diversion.why,
        ...(j.diversion.questionId ? { questionId: j.diversion.questionId } : {}), ...(j.diversion.claimId ? { claimId: j.diversion.claimId } : {}) } } : {}),
      ...(committed?.dodged.length ? { dodged: committed.dodged.map((q) => q.id) } : {}),
    };
    // Who said what, and when: the quotes a diversion rests on.
    if (decision.diversion) {
      const q = decision.diversion.questionId ? this.memory.questions.find((x) => x.id === decision.diversion!.questionId) : undefined;
      const c = decision.diversion.claimId ? this.memory.claims.find((x) => x.id === decision.diversion!.claimId) : undefined;
      decision.diversion.quotes = [...(q ? [quoteOfQuestion(q)] : []), ...(c ? [quoteOfClaim(c)] : []), quoteOf(decision)];
    }
    decision.latencyMs = this.clock() - t0;
    this.decisions.push(decision);
    this.emit({ type: 'decision', decision, ...(committed ? { committed } : {}) });
    if (committed) for (const i of this.cards(decision, committed, state.current.topic)) this.emitInsight(i);
    return decision;
  }

  private emitInsight(i: Insight): void {
    // The same diversion carried into the next sentence of the same turn is one card, not two.
    const last = this.insights[this.insights.length - 1];
    if (last && i.kind === 'diversion' && last.kind === 'diversion' && last.type === i.type && last.speaker === i.speaker
      && this.memory.turns.slice(-2).every((t) => t.speaker === i.speaker)) {
      last.quotes = [...last.quotes, ...i.quotes.filter((q) => !last.quotes.some((x) => x.utteranceId === q.utteranceId))];
      last.detail = `“${last.quotes.filter((q) => q.speaker === i.speaker).map((q) => q.text).join(' ')}”`;
      this.emit({ type: 'insight', insight: last });
      return;
    }
    this.insights.push(i);
    this.emit({ type: 'insight', insight: i });
  }

  private card(kind: InsightKind, d: JevDecision, body: Pick<Insight, 'text' | 'detail'>, extra: Partial<Insight> = {}): Insight {
    return { id: `i${++this.insightSeq}`, kind, status: 'confirmed', speaker: d.speaker, atMs: d.atMs, quotes: [quoteOf(d)],
      decisionId: d.id, utteranceId: d.utteranceId, ...body, ...extra };
  }

  /** The cards a finished utterance earns. */
  private cards(d: JevDecision, c: Committed, from: string | null): Insight[] {
    const out: Insight[] = [];
    for (const q of c.dodged) {
      out.push(this.card('dodged', d, dodgedCard(q, q.turnsSince), { speaker: q.to ?? d.speaker, quotes: [quoteOfQuestion(q)], questionId: q.id, type: 'question_dodged' }));
    }
    if (d.ignored) return out;
    if (c.settled) {
      out.push(this.card('correction', d, { text: `${d.speaker} corrected ${c.settled.from.text.length < 60 ? `“${c.settled.from.text}”` : 'an earlier figure'} — the new figure stands.`, detail: `“${d.text}”` }, { claimId: c.settled.to.id }));
    } else if (d.diversion) {
      const q = d.diversion.questionId ? this.memory.questions.find((x) => x.id === d.diversion!.questionId) : undefined;
      const claim = d.diversion.claimId ? this.memory.claims.find((x) => x.id === d.diversion!.claimId) : undefined;
      const kind: InsightKind = d.diversion.type === 'changed_claim' || d.diversion.type === 'moving_goalposts' ? 'contradiction' : 'diversion';
      out.push(this.card(kind, d, diversionCard(d, from, q, claim), { type: d.diversion.type, quotes: d.diversion.quotes,
        ...(q ? { questionId: q.id } : {}), ...(claim ? { claimId: claim.id } : {}) }));
    } else if (d.shiftType !== 'none' && from && d.topic) {
      const open = this.memory.questions.filter((q) => q.status === 'open' && q.topic === from && q.to === d.speaker);
      const body = shiftCard(d, from, open);
      if (body) out.push(this.card('shift', d, body));
    }
    const ev = d.claim?.contradicts?.evidenceId ? (this.opts.evidence ?? []).find((e) => e.id === d.claim!.contradicts!.evidenceId) : undefined;
    if (ev) out.push(this.card('evidence', d, evidenceCard(d, ev), { evidenceId: ev.id }));
    if (c.reasked && c.reasked.asks > 1) {
      out.push(this.card('repeat', d, { text: `${d.speaker} asked again: “${c.reasked.text}”`, detail: `First asked by ${c.reasked.by} at ${clockOf(c.reasked.askedMs)}; asked ${c.reasked.asks} times.` }, { questionId: c.reasked.id }));
    }
    return out;
  }

  /** Step-2 baseline: answer when addressed, at the end of the sentence. Step 6 replaces this with the Lines rules. */
  private timing(h: Heard, j: Judgment, c: Committed | undefined): RespondState {
    if (j.ignore) return 'listen';
    if (j.addressedToHepta && h.final) return 'respond';
    if (c && (j.shiftType !== 'none' || j.diversion || c.claims.length > 0 || c.asked)) return 'note';
    return 'listen';
  }
}
