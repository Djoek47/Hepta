/**
 * The listener. Every chunk a recognizer delivers goes through here, in
 * order: who said it, whether a clause just ended, what the detector makes of
 * it, what that changes in the conversation's memory, what cards it earns, and
 * whether Hepta should say anything. One JevDecision comes out per chunk.
 *
 * The detector is the swappable part. Everything else here is rules, and the
 * rules do not change when the detector gets better.
 */
import { atBoundary, BREATH_MS } from './boundary.js';
import { mentionsHepta, addressesHepta } from './cues.js';
import {
  diversionCard, dodgedCard, evidenceCard, quoteOf, quoteOfClaim, quoteOfQuestion, shiftCard, type Insight, type InsightKind,
} from './insights.js';
import { Memory, type Committed } from './memory.js';
import { TemplateResponder, writeResponse, type Responder, type ResponseCard, type ResponseReason, type ResponseRequest } from './respond.js';
import { SpeakerTracker } from './speakers.js';
import { clock as clockOf, relDiff } from './text.js';
import { pointsOf, Timing, type Point } from './timing.js';
import type {
  Detector, EvidenceItem, Heard, JevDecision, Judgment, Mode, SpeakerRole, StanceSeed, SttChunk,
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
  /** Quiet this long after a sentence ends before a held answer is given. Default 700 ms. */
  turnEndMs?: number;
  bluntness?: number;
  /** Writes response cards. The local template when omitted. */
  responder?: Responder;
  /** Wall clock in ms, for latency. performance.now by default. */
  clock?: () => number;
};

export type ListenEvent =
  | { type: 'heard'; heard: Heard }
  | { type: 'decision'; decision: JevDecision; committed?: Committed }
  | { type: 'insight'; insight: Insight }
  | { type: 'response'; card: ResponseCard }
  | { type: 'floor'; floor: 'keep' | 'yield'; why: string };

/** A confident reading of half a sentence, shown early. */
const EARLY_P = 0.55;
const EARLY_MARGIN = 0.15;

export class Listener {
  readonly speakers = new SpeakerTracker();
  readonly memory: Memory;
  readonly timing: Timing;
  readonly decisions: JevDecision[] = [];
  readonly insights: Insight[] = [];
  readonly responses: ResponseCard[] = [];
  readonly mode: Mode;
  private readonly fns = new Set<(e: ListenEvent) => void>();
  private readonly clock: () => number;
  private readonly responder: Responder;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private insightSeq = 0;
  private responseSeq = 0;
  /** A response held for the end of the speaker's turn. `speaking`: someone started talking since. */
  private held: { point: Point; speaker: string; endMs: number; decision: JevDecision; speaking?: number } | null = null;
  /** The provisional card for each utterance still being spoken. */
  private early = new Map<string, Insight>();
  /** Insights raised since Hepta last spoke. */
  private sinceSpoke: Insight[] = [];
  private lastAudioMs = 0;

  constructor(private readonly opts: ListenerOptions) {
    this.mode = opts.mode;
    this.clock = opts.clock ?? (() => performance.now());
    this.memory = new Memory(opts.halfLifeMs, opts.dodgeTurns ?? 2);
    this.timing = new Timing(opts.mode, { ...(opts.stance ? { stance: opts.stance } : {}), ...(opts.turnEndMs !== undefined ? { turnEndMs: opts.turnEndMs } : {}), ...(opts.bluntness !== undefined ? { bluntness: opts.bluntness } : {}) });
    this.responder = opts.responder ?? new TemplateResponder();
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

  /** Hepta has started or stopped speaking its answer aloud (TTS). */
  setSpeaking(on: boolean): void {
    this.timing.speaking = on;
  }

  /** Chunks are decided in the order they arrive, whatever the detector's latency. */
  hear(chunk: SttChunk): Promise<JevDecision> {
    const next = this.queue.then(() => this.decide(chunk));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Time passes with nobody speaking (audio time). A response held for the end
   * of a turn is given once the speaker has been quiet long enough.
   */
  tick(audioMs: number): Promise<JevDecision | null> {
    const next = this.queue.then(() => this.fireHeld(audioMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Voice activity: someone started speaking. A held answer waits to see who —
   * the same speaker going on, or someone else taking the floor — instead of
   * talking over them on a timer.
   */
  speechStarted(atMs: number): void {
    if (this.held && atMs > this.held.endMs) this.held.speaking = atMs;
  }

  private async fireHeld(audioMs: number, cutBy?: string): Promise<JevDecision | null> {
    const h = this.held;
    if (!h) return null;
    const due = h.endMs + this.timing.turnEndMs;
    if (!cutBy && (audioMs < due || (h.speaking !== undefined && h.speaking < due))) return null;
    this.held = null;
    const at = cutBy ? Math.min(audioMs, due) : due;
    const d: JevDecision = { ...h.decision, id: `d${++this.seq}`, atMs: at, respondState: 'respond', trigger: 'turn-end', latencyMs: 0, detectorMs: 0,
      why: cutBy ? `the turn ended (${cutBy} spoke)` : `the turn ended (${this.timing.turnEndMs} ms of quiet)` };
    this.decisions.push(d);
    this.emit({ type: 'decision', decision: d });
    this.respond(d, h.point);
    return d;
  }

  private async decide(chunk: SttChunk): Promise<JevDecision> {
    const t0 = this.clock();
    const speaker = this.speakers.resolve(chunk);
    // Speech from someone else ends a held turn; more speech from the same person defers it
    // to the end of their latest sentence.
    if (this.held) {
      if (speaker !== this.held.speaker) await this.fireHeld(chunk.startMs, speaker);
      else if (chunk.startMs >= this.held.endMs + this.timing.turnEndMs) await this.fireHeld(chunk.startMs);
      else if (chunk.final) { this.held.endMs = Math.max(this.held.endMs, chunk.endMs); delete this.held.speaking; }
    }
    const heard: Heard = {
      id: `h${++this.seq}`, utteranceId: chunk.utteranceId, speaker, text: chunk.text, final: chunk.final,
      startMs: chunk.startMs, endMs: chunk.endMs, atMs: chunk.heardToMs,
      boundary: atBoundary(chunk, this.opts.breathMs ?? BREATH_MS), words: chunk.words,
      ...(chunk.event ? { event: chunk.event } : {}),
    };
    this.lastAudioMs = Math.max(this.lastAudioMs, heard.atMs);
    this.emit({ type: 'heard', heard });

    this.memory.bindNames(this.speakers.list());
    const state = this.memory.snapshot(this.mode, this.speakers.list(), heard.atMs, this.opts.evidence ?? [], this.opts.stance);
    const d0 = this.clock();
    const j = await this.opts.detector.detect(heard, state);
    const detectorMs = this.clock() - d0;

    const committed = heard.final ? this.memory.commit(heard, j) : undefined;
    if (heard.final) this.speakers.heard(speaker, j.ignore);

    const decision: JevDecision = {
      id: `d${this.seq}`, heardId: heard.id, utteranceId: heard.utteranceId, final: heard.final,
      speaker, text: heard.text, atMs: heard.atMs,
      topic: j.topic, shiftType: j.shiftType, shiftFrom: state.current.topic,
      addressedToHepta: j.addressedToHepta, respondState: 'listen', confidence: j.confidence,
      latencyMs: 0, detectorMs, backend: this.opts.detector.name, provisional: !heard.final,
      boundary: heard.boundary, readings: j.readings, trigger: 'chunk',
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

    // Cards: early on half a sentence, settled on the whole one.
    const cards = committed ? this.settleCards(decision, committed, state.current.topic) : this.earlyCard(decision, state.current.topic);

    // A stance Hepta has pushed is answered by what the other side says next.
    if (heard.final && !j.ignore) {
      const role = this.speakers.get(speaker)?.role;
      const r = this.timing.reply(heard, role !== 'moderator');
      if (r && r !== 'no-stance') decision.why = `stance ${r}`;
    }

    // The timing.
    const prior = this.memory.claims.find((c) => c.id === j.diversion?.claimId);
    const rel = prior?.value !== undefined && j.claim?.value !== undefined ? relDiff(prior.value, j.claim.value) : undefined;
    const challenge = !j.addressedToHepta && mentionsHepta(heard.text) && !addressesHepta(heard.text)
      && /\b(wrong|not true|nonsense|disagree|rubbish|mistaken)\b/i.test(heard.text) && this.mode !== 'debater';
    const points = pointsOf(this.mode, heard, j, { ...(this.opts.stance ? { stanceKeys: this.opts.stance.keys } : {}), ...(rel !== undefined ? { rel } : {}), mentionsChallenge: challenge });
    const noted = cards.length > 0 || !!committed?.claims.length || !!committed?.asked;
    const t = this.timing.decide(heard, j, points, noted);
    decision.respondState = t.state;
    decision.why = [decision.why, t.why].filter(Boolean).join('; ');
    if (t.floor) this.emit({ type: 'floor', floor: t.floor, why: t.why });
    if (t.atTurnEnd && t.point) this.held = { point: t.point, speaker, endMs: heard.endMs, decision };

    decision.latencyMs = this.clock() - t0;
    this.decisions.push(decision);
    this.emit({ type: 'decision', decision, ...(committed ? { committed } : {}) });
    for (const i of cards) this.emitInsight(i);
    if (t.state === 'respond' && t.point) this.respond(decision, t.point);
    return decision;
  }

  // ------------------------------------------------------------------- cards

  private emitInsight(i: Insight): void {
    const existing = this.insights.find((x) => x.id === i.id);
    if (existing) {
      Object.assign(existing, i);
      this.emit({ type: 'insight', insight: existing });
      return;
    }
    // The same diversion carried into the next sentence of the same turn is one card, not two.
    const last = this.insights[this.insights.length - 1];
    if (last && i.kind === 'diversion' && last.kind === 'diversion' && last.type === i.type && last.speaker === i.speaker && last.status !== 'retracted'
      && this.memory.turns.slice(-2).every((t) => t.speaker === i.speaker)) {
      last.quotes = [...last.quotes, ...i.quotes.filter((q) => !last.quotes.some((x) => x.utteranceId === q.utteranceId))];
      last.detail = `“${last.quotes.filter((q) => q.speaker === i.speaker).map((q) => q.text).join(' ')}”`;
      this.emit({ type: 'insight', insight: last });
      return;
    }
    this.insights.push(i);
    if (i.status !== 'retracted' && i.kind !== 'repeat') this.sinceSpoke.push(i);
    this.emit({ type: 'insight', insight: i });
  }

  private card(kind: InsightKind, d: JevDecision, body: Pick<Insight, 'text' | 'detail'>, extra: Partial<Insight> = {}): Insight {
    return { id: `i${++this.insightSeq}`, kind, status: 'confirmed', speaker: d.speaker, atMs: d.atMs, quotes: [quoteOf(d)],
      decisionId: d.id, utteranceId: d.utteranceId, ...body, ...extra };
  }

  private diversionInsight(d: JevDecision, from: string | null): Insight | null {
    if (!d.diversion) return null;
    const q = d.diversion.questionId ? this.memory.questions.find((x) => x.id === d.diversion!.questionId) : undefined;
    const claim = d.diversion.claimId ? this.memory.claims.find((x) => x.id === d.diversion!.claimId) : undefined;
    const kind: InsightKind = d.diversion.type === 'changed_claim' || d.diversion.type === 'moving_goalposts' ? 'contradiction' : 'diversion';
    return this.card(kind, d, diversionCard(d, from, q, claim), { type: d.diversion.type, quotes: d.diversion.quotes,
      ...(q ? { questionId: q.id } : {}), ...(claim ? { claimId: claim.id } : {}) });
  }

  /**
   * Half a sentence: if one reading clearly leads — a diversion, a changed
   * figure — show it now, marked provisional. If the lead changes, take it back.
   */
  private earlyCard(d: JevDecision, from: string | null): Insight[] {
    if (d.ignored) return [];
    const [top, second] = d.readings;
    const shown = this.early.get(d.utteranceId);
    const leads = top && top.label.startsWith('diversion:') && top.p >= EARLY_P && top.p - (second?.p ?? 0) >= EARLY_MARGIN && d.diversion
      && top.label === `diversion:${d.diversion.type}`;
    if (shown && (!leads || shown.type !== d.diversion?.type)) {
      this.early.delete(d.utteranceId);
      return [{ ...shown, status: 'retracted' }];
    }
    if (!leads || shown) return [];
    const i = this.diversionInsight(d, from);
    if (!i) return [];
    const early = { ...i, status: 'provisional' as const, shownAtMs: d.atMs };
    this.early.set(d.utteranceId, early);
    return [early];
  }

  /** The whole sentence: confirm or retract what was shown early, and add what it earns. */
  private settleCards(d: JevDecision, c: Committed, from: string | null): Insight[] {
    const out: Insight[] = [];
    const shown = this.early.get(d.utteranceId);
    this.early.delete(d.utteranceId);
    for (const q of c.dodged) {
      out.push(this.card('dodged', d, dodgedCard(q, q.turnsSince), { speaker: q.to ?? d.speaker, quotes: [quoteOfQuestion(q)], questionId: q.id, type: 'question_dodged' }));
    }
    if (d.ignored) {
      if (shown) out.push({ ...shown, status: 'retracted' });
      return out;
    }
    if (c.settled) {
      if (shown) out.push({ ...shown, status: 'retracted' });
      out.push(this.card('correction', d, { text: `${d.speaker} corrected ${c.settled.from.text.length < 60 ? `“${c.settled.from.text}”` : 'an earlier figure'} — the new figure stands.`, detail: `“${d.text}”` }, { claimId: c.settled.to.id }));
    } else if (d.diversion) {
      const i = this.diversionInsight(d, from)!;
      // The point formed on half a sentence, rechecked on the whole: kept if it still holds.
      if (shown && shown.type === d.diversion.type) out.push({ ...i, id: shown.id, status: 'confirmed', shownAtMs: shown.shownAtMs! });
      else {
        if (shown) out.push({ ...shown, status: 'retracted' });
        out.push(i);
      }
    } else {
      if (shown) out.push({ ...shown, status: 'retracted' });
      if (d.shiftType !== 'none' && from && d.topic) {
        const open = this.memory.questions.filter((q) => q.status === 'open' && q.topic === from && q.to === d.speaker);
        const body = shiftCard(d, from, open);
        if (body) out.push(this.card('shift', d, body));
      }
    }
    const ev = d.claim?.contradicts?.evidenceId ? (this.opts.evidence ?? []).find((e) => e.id === d.claim!.contradicts!.evidenceId) : undefined;
    if (ev) out.push(this.card('evidence', d, evidenceCard(d, ev), { evidenceId: ev.id }));
    if (c.reasked && c.reasked.asks > 1) {
      out.push(this.card('repeat', d, { text: `${d.speaker} asked again: “${c.reasked.text}”`, detail: `First asked by ${c.reasked.by} at ${clockOf(c.reasked.askedMs)}; asked ${c.reasked.asks} times.` }, { questionId: c.reasked.id }));
    }
    return out;
  }

  // ---------------------------------------------------------------- responses

  private request(d: JevDecision, p: Point): ResponseRequest {
    const reason: ResponseReason = p.reason === 'question' ? (this.mode === 'panel' ? 'cue' : 'question')
      : p.reason === 'against-stance' ? 'against-stance' : p.reason === 'contradiction' ? 'contradiction' : 'point';
    const live = (i: Insight) => i.status !== 'retracted';
    let points = this.sinceSpoke.filter(live);
    if (reason === 'contradiction' || reason === 'against-stance') {
      const mine = this.insights.filter((i) => live(i) && i.utteranceId === d.utteranceId);
      points = mine.length ? mine : points.slice(-1);
    }
    const stance = this.timing.stance();
    return {
      mode: this.mode, reason, said: quoteOf(d),
      points: points.map((i) => ({ text: i.text, ...(i.detail ? { detail: i.detail } : {}), quotes: i.quotes })),
      recent: this.memory.turns.filter((t) => !t.ignored).slice(-8).map((t) => ({ speaker: t.speaker, text: t.text, atMs: t.startMs, utteranceId: t.utteranceId })),
      open: this.memory.questions.filter((q) => q.status !== 'answered').map((q) => ({ text: q.text, by: q.by, to: q.to, askedMs: q.askedMs, status: q.status })),
      claims: this.memory.claims.slice(-12).map((c) => ({ speaker: c.speaker, subject: c.subject, atMs: c.atMs, text: c.text, status: c.status,
        ...(c.value !== undefined ? { value: c.value } : {}), ...(c.unit ? { unit: c.unit } : {}) })),
      evidence: this.opts.evidence ?? [],
      ...(this.opts.stance ? { stance: { position: this.opts.stance.position, confidence: stance?.confidence ?? this.opts.stance.confidence,
        conceded: !!stance?.conceded, overridden: !!stance?.overridden, replies: this.timing.stanceLog.map((x) => x.text) } } : {}),
      speakers: this.speakers.list(),
    };
  }

  /** Write the response card. Runs alongside listening: the next chunk does not wait for it. */
  private respond(d: JevDecision, p: Point): void {
    const req = this.request(d, p);
    if (this.mode === 'panel') this.timing.spent();
    this.sinceSpoke = [];
    const card: ResponseCard = { id: `r${++this.responseSeq}`, decisionId: d.id, status: 'writing', text: '', responder: this.responder.name,
      reason: req.reason, atMs: d.atMs, cites: req.points.flatMap((x) => x.quotes).slice(0, 6) };
    this.responses.push(card);
    const t0 = this.clock();
    this.emit({ type: 'response', card: { ...card } });
    void writeResponse(req, this.responder, (delta) => {
      if (card.firstMs === undefined) card.firstMs = this.clock() - t0;
      card.text += delta;
      this.emit({ type: 'response', card: { ...card } });
    }).then((r) => {
      card.text = r.text;
      card.responder = r.responder;
      card.ledger = r.ledger;
      card.status = 'done';
      card.totalMs = this.clock() - t0;
      if (card.firstMs === undefined) card.firstMs = card.totalMs;
      if (r.error) card.error = r.error;
      this.emit({ type: 'response', card: { ...card } });
    }, (e: unknown) => {
      card.status = 'failed';
      card.error = String((e as Error)?.message ?? e);
      this.emit({ type: 'response', card: { ...card } });
    });
  }

  /** Everything, for the export: what was heard, decided, shown and said. */
  get audioMs(): number {
    return this.lastAudioMs;
  }
}

/** Keep Judgment in the public surface for detectors written elsewhere. */
export type { Judgment };
