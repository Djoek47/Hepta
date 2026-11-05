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
import { Memory, type Committed } from './memory.js';
import { SpeakerTracker } from './speakers.js';
import type {
  Detector, EvidenceItem, Heard, JevDecision, Judgment, Mode, RespondState, SpeakerRole, StanceSeed, SttChunk,
} from './types.js';

export type ListenerOptions = {
  mode: Mode;
  detector: Detector;
  evidence?: EvidenceItem[];
  stance?: StanceSeed;
  breathMs?: number;
  /** Wall clock in ms, for latency. performance.now by default. */
  clock?: () => number;
};

export type ListenEvent =
  | { type: 'heard'; heard: Heard }
  | { type: 'decision'; decision: JevDecision; committed?: Committed };

export class Listener {
  readonly speakers = new SpeakerTracker();
  readonly memory = new Memory();
  readonly decisions: JevDecision[] = [];
  readonly mode: Mode;
  private readonly fns = new Set<(e: ListenEvent) => void>();
  private readonly clock: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly opts: ListenerOptions) {
    this.mode = opts.mode;
    this.clock = opts.clock ?? (() => performance.now());
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
    };
    decision.latencyMs = this.clock() - t0;
    this.decisions.push(decision);
    this.emit({ type: 'decision', decision, ...(committed ? { committed } : {}) });
    return decision;
  }

  /** Step-2 baseline: answer when addressed, at the end of the sentence. Step 6 replaces this with the Lines rules. */
  private timing(h: Heard, j: Judgment, c: Committed | undefined): RespondState {
    if (j.ignore) return 'listen';
    if (j.addressedToHepta && h.final) return 'respond';
    if (c && (j.shiftType !== 'none' || j.diversion || c.claims.length > 0 || c.asked)) return 'note';
    return 'listen';
  }
}
