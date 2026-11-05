/**
 * Lines of thought. The part of Hepta that thinks about something other than
 * the sentence in front of it.
 *
 * The seven tongues in index.ts are the FOREGROUND: several readings of what is
 * being said right now, none allowed to commit until the speaker stops. That
 * is listening. It is not conversation. Conversation needs the other lines:
 *
 *   what you said five minutes ago, and whether this contradicts it
 *   a view it holds, and whether what you are about to do runs against it
 *   something left open, that it can wander back to when you go quiet
 *
 * Each is a Thread, and every thread is evaluated on every partial, in
 * parallel with the foreground. That is what "multiple lines of thought" is
 * here: not one model thinking harder, but several small questions asked of
 * each word as it arrives, each with its own memory of where it came from.
 *
 * Three behaviours come out of that, and each has a rule, because each is
 * something a person forgives in a friend and not in a machine:
 *
 * CUTTING IN. People interrupt at clause boundaries — after "and", "but", a
 * breath — not in the middle of a word. A system that cuts in mid-phrase is
 * rude however right it is. So an urge to speak waits for a boundary, unless
 * it is urgent enough that waiting would cost more than the rudeness (about
 * to confirm a payment that contradicts what it knows).
 *
 * HOLDING THE FLOOR. While it is speaking and you say "yeah", it keeps going;
 * that is a backchannel, not a turn. "Wait" or "no" or three real words is a
 * turn, and it stops. Stopping on every "mm" is why voice assistants feel
 * like they are being shouted down.
 *
 * ARGUING. A stance carries evidence and a confidence. A reason from you
 * lowers the confidence, and below a floor it concedes. An override from you
 * — "do it anyway" — ends the argument: you are the conductor, the stance
 * yields, and the disagreement is recorded so it is not raised again unless
 * something new comes up. A debater that cannot lose is not arguing, it is
 * nagging, and one that argues more than once per disagreement at default
 * bluntness is the same thing with better manners.
 *
 * WANDERING. When nothing is on stage and you have gone quiet, it may pick an
 * unresolved thread and go back to it. Weight decays with time, rises when
 * the thread's words come up again, and a thread just raised rests.
 *
 * None of this generates language. A decision says what to raise and why; a
 * model says it. Every detector here is tier 0 — word overlap and numbers —
 * and the `Detector` interface is where a fast classifier (Jev-class) plugs in
 * when it is available. The rules around the detectors do not change when the
 * detectors get better, which is the point of keeping them apart.
 */

import type { Ctx } from '@intermenu/aiuic-core';
import { endsInOpenNumber, resolveQuantity } from '@intermenu/aiuic-resolve';

// ------------------------------------------------------------------- threads

export type Stance = {
  /** What it thinks, in a sentence a model can say. */
  position: string;
  evidence: string[];
  /** 0..1. Falls with each reason given against it. */
  confidence: number;
  /** Acts this stance argues against — "you said you're saving for the trip". */
  against?: string[];
  /** Times it has pushed in this disagreement. */
  pushes: number;
  /** The conductor overrode it. It does not raise this again without new evidence. */
  overridden: boolean;
  /** It was argued out of it. */
  conceded: boolean;
};

export type ThreadKind = 'claim' | 'stance' | 'question' | 'aside';

export type Thread = {
  id: string;
  kind: ThreadKind;
  /** A short name for what it is about. */
  topic: string;
  /** Words that make this thread relevant when they come up. */
  keys: string[];
  /** Where it came from. */
  said: { text: string; atMs: number };
  /** For claims: the number that was stated, if any. */
  value?: number;
  stance?: Stance;
  weight: number;
  resolved: boolean;
  lastRaisedMs: number | null;
};

/** A partial transcript with its time. `Partial` would shadow TypeScript's own. */
export type Heard = { text: string; final: boolean; atMs: number };

// ----------------------------------------------------------------- detectors

export type Urge = {
  thread: Thread;
  /** 0..1. How much this line wants the floor right now. */
  urge: number;
  reason: 'contradiction' | 'against-stance' | 'return' | 'question';
  /** One line a model can turn into speech. */
  say: string;
};

export type Detector = (p: Heard, t: Thread, ctx: DetectCtx) => Urge | null;

export type DetectCtx = {
  /** The foreground act Hepta is leading with, if any. */
  leader: string | null;
  /** Radius of the leader. Urgency rises with what a mistake would cost. */
  leaderRadius: string | null;
};

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9$€£.\s']/g, ' ').split(/\s+/).filter(Boolean);

function overlap(text: string, keys: string[]): number {
  if (keys.length === 0) return 0;
  const words = new Set(tokens(text));
  const hit = keys.filter((k) => k.toLowerCase().split(/\s+/).every((w) => words.has(w))).length;
  return hit / keys.length;
}

function numberIn(text: string): number | null {
  const c = resolveQuantity(text, {} as Ctx)[0];
  const v = c?.value as { n?: number } | undefined;
  return typeof v?.n === 'number' ? v.n : null;
}

/** You said one number before; you are saying another now, about the same thing. */
export const contradiction: Detector = (p, t) => {
  if (t.value === undefined || t.resolved) return null;
  if (t.stance?.overridden) return null;
  if (overlap(p.text, t.keys) < 0.5) return null;
  // "going to be four…" may still become "four hundred". Cutting in on the
  // first word of a number was a wrong cut in the harder debate suite.
  if (!p.final && endsInOpenNumber(p.text)) return null;
  const n = numberIn(p.text);
  if (n === null || t.value === 0) return null;
  const rel = Math.abs(n - t.value) / Math.abs(t.value);
  if (rel < 0.25) return null;
  return {
    thread: t, reason: 'contradiction',
    urge: Math.min(1, 0.55 + rel / 2),
    say: `Earlier you said your ${t.topic} was ${t.value}; now it's ${n}.`,
  };
};

/** The act being spoken runs against a view this line holds. */
export const againstStance: Detector = (p, t, ctx) => {
  const s = t.stance;
  if (!s || s.overridden || s.conceded || t.resolved) return null;
  if (!ctx.leader || !s.against?.includes(ctx.leader)) return null;
  const costly = ctx.leaderRadius === 'external' ? 0.2 : ctx.leaderRadius === 'other-person' ? 0.1 : 0;
  return {
    thread: t, reason: 'against-stance',
    urge: Math.min(1, 0.45 + s.confidence * 0.35 + costly),
    say: s.position,
  };
};

/** Something left open has just come up again. Not a reason to cut in; a reason to come back. */
export const returning: Detector = (p, t) => {
  if (t.resolved || t.kind === 'stance') return null;
  const o = overlap(p.text, t.keys);
  if (o < 0.5) return null;
  // A number said about a claim is the claim being updated or contradicted,
  // and each of those has its own handling. Saying "that connects to what you
  // said about your grocery budget" to someone revising their grocery budget
  // is a system narrating the obvious.
  if (t.kind === 'claim' && numberIn(p.text) !== null) return null;
  return {
    thread: t, reason: 'return',
    urge: Math.min(0.5, 0.2 + o * 0.3),
    say: `That connects to what you said about ${t.topic}.`,
  };
};

export const DEFAULT_DETECTORS: Detector[] = [contradiction, againstStance, returning];

// ------------------------------------------------------------------ decisions

export type Decision =
  /** Keep listening. */
  | { kind: 'listen' }
  /** Take the floor now. */
  | { kind: 'interrupt'; urge: Urge; at: 'boundary' | 'urgent' }
  /** Say it when they finish. */
  | { kind: 'queue'; urge: Urge }
  /** We were speaking and they took the turn. Stop. */
  | { kind: 'yield'; why: string }
  /** We were speaking and that was a backchannel. Keep going. */
  | { kind: 'keep' };

export type LinesConfig = {
  /**
   * 0..1. How readily it cuts in and how hard it argues. Not a personality
   * slider with no floor: at 0 it still interrupts for something urgent, and
   * at 1 it still yields to an override.
   */
  bluntness?: number;
  /** Above this it cuts in at the next word, boundary or not. */
  urgent?: number;
  /** A gap this long between partials is a breath — a boundary. */
  breathMs?: number;
  /** Quiet this long, with nothing on stage, before it may wander. */
  idleMs?: number;
  /** A thread just raised rests this long. */
  restMs?: number;
  /** Half-life of a thread's weight. */
  halfLifeMs?: number;
  detectors?: Detector[];
};

export const DEFAULTS = {
  bluntness: 0.5,
  urgent: 0.9,
  breathMs: 350,
  idleMs: 6000,
  restMs: 45_000,
  halfLifeMs: 5 * 60_000,
} as const;

/** Words that end a clause, so the next word is somewhere a person could come in. */
const BOUNDARY = new Set([
  'and', 'but', 'so', 'because', 'then', 'or', 'anyway', 'okay', 'ok', 'right',
  // French: the same joints of a sentence.
  'et', 'mais', 'donc', 'parce', 'puis', 'ou', 'bref', 'bon', 'alors', 'enfin',
]);
/** Sounds that say "go on", not "my turn". */
const BACKCHANNEL = new Set(['yeah', 'yes', 'yep', 'mm', 'mhm', 'uh-huh', 'uh', 'huh', 'ok', 'okay', 'right', 'sure', 'hmm', 'ah', 'oh']);
/** Words that take the floor however few there are. */
const TAKE_FLOOR = ['wait', 'no', 'stop', 'hold on', 'hang on', 'but', 'actually', 'listen'];

const OVERRIDE = [/\b(do it|just do it) anyway\b/, /\bi (don'?t|do not) care\b/, /\bi know\b/, /\bjust do it\b/,
  /\bmy (call|decision|money|choice)\b/, /\bdo it\b/, /\bgo ahead\b/];
const AGREE = [/\byou'?re right\b/, /\bgood point\b/, /\bfair\b/, /\bok(ay)? fine\b/, /\byou win\b/, /\bdon'?t do it\b/, /\bcancel\b/];
const REASON = [/\bbecause\b/, /\bsince\b/, /\bactually\b/, /\bthe thing is\b/, /\bbut\b/];

export type Reply = 'overridden' | 'conceded' | 'agreed' | 'holding' | 'no-stance';

export class Lines {
  private threads: Thread[] = [];
  private seq = 0;
  private lastPartialMs: number | null = null;
  private lastHeardMs = 0;
  private queued: Urge | null = null;
  private readonly cfg: Required<Omit<LinesConfig, 'detectors'>> & { detectors: Detector[] };

  constructor(config: LinesConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config, detectors: config.detectors ?? DEFAULT_DETECTORS };
  }

  get all(): readonly Thread[] {
    return this.threads;
  }

  /** The threshold for cutting in at a boundary. Bluntness moves it; nothing removes it. */
  get threshold(): number {
    return 0.8 - this.cfg.bluntness * 0.25;
  }

  /** How many times a stance may push in one disagreement. */
  get maxPushes(): number {
    return this.cfg.bluntness >= 0.75 ? 2 : 1;
  }

  // ------------------------------------------------------------- adding lines

  note(t: Omit<Thread, 'id' | 'weight' | 'resolved' | 'lastRaisedMs'> & Partial<Pick<Thread, 'weight'>>): Thread {
    const thread: Thread = { weight: 1, ...t, id: `t${++this.seq}`, resolved: false, lastRaisedMs: null };
    this.threads.push(thread);
    return thread;
  }

  /** A view it holds, with evidence. The pyramid's findings are where these come from. */
  hold(topic: string, keys: string[], stance: Omit<Stance, 'pushes' | 'overridden' | 'conceded'>, atMs: number): Thread {
    return this.note({
      kind: 'stance', topic, keys, said: { text: stance.position, atMs },
      stance: { ...stance, pushes: 0, overridden: false, conceded: false },
    });
  }

  /**
   * Pick up claims from a finished sentence: "my grocery budget is 400"
   * becomes a thread a later "600 on groceries" can contradict. Tier 0: a
   * noun phrase, a copula, a number. A real extractor replaces this; the
   * contradiction rule does not change when it does.
   */
  listenFor(p: Heard): Thread | null {
    if (!p.final) return null;
    // English, then French ("mon budget courses est de 400").
    const m = /\b(?:my|our|the)\s+([a-z][a-z ]{1,40}?)\s+(?:is|are|was|=|will be|should be)\s+(.+)$/i.exec(p.text)
      ?? /\b(?:mon|ma|mes|notre|nos|le|la|les)\s+([a-z][a-z ]{1,40}?)\s+(?:est|sont|etait|sera|va etre)\s+(?:de\s+)?(.+)$/i
        .exec(p.text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    if (!m) return null;
    const n = numberIn(m[2]!);
    if (n === null) return null;
    const topic = m[1]!.trim().toLowerCase();
    const keys = topic.split(/\s+/).filter((w) => w.length > 3);
    if (keys.length === 0) return null;
    const existing = this.threads.find((t) => t.kind === 'claim' && t.topic === topic);
    if (existing) {
      // A small revision updates. A contradiction does not: overwriting 400
      // with 600 the moment 600 is said is the system quietly changing what it
      // believes about you, which is the one thing memory promised never to
      // do. The old value stands until the contradiction has been raised and
      // answered — then `settle()` writes the new one.
      const rel = existing.value ? Math.abs(n - existing.value) / Math.abs(existing.value) : 1;
      if (rel >= 0.25 && !existing.resolved) return existing;
      existing.value = n; existing.said = { text: p.text, atMs: p.atMs }; existing.weight = 1;
      return existing;
    }
    return this.note({ kind: 'claim', topic, keys, value: n, said: { text: p.text, atMs: p.atMs } });
  }

  // --------------------------------------------------------------- listening

  /**
   * Every partial goes through here, alongside the foreground speculation.
   * `speaking` means the system has the floor right now.
   */
  hear(p: Heard, ctx: DetectCtx & { speaking?: boolean } = { leader: null, leaderRadius: null }): Decision {
    const gap = this.lastPartialMs === null ? 0 : p.atMs - this.lastPartialMs;
    this.lastPartialMs = p.final ? null : p.atMs;
    this.lastHeardMs = p.atMs;
    this.decay(p.atMs);

    if (ctx.speaking) return this.floor(p);

    const urges = this.urges(p, ctx);
    for (const u of urges) u.thread.weight = Math.min(2, u.thread.weight + 0.25);
    const top = urges[0];

    if (p.final) {
      this.listenFor(p);
      // A point queued mid-sentence was formed on half a sentence. It is kept
      // only if it still holds on the whole one: "the grocery budget is more
      // like" sounds like a return to the budget, and "...more like 420" turns
      // out to be a revision of it. Whatever still fires now is what is true.
      const queuedThread = this.queued?.thread;
      this.queued = null;
      const q = urges.find((u) => u.thread === queuedThread) ?? top;
      if (q && q.urge >= 0.3) return this.raise(q, 'queue', p.atMs);
      return { kind: 'listen' };
    }

    if (!top) return { kind: 'listen' };

    if (top.urge >= this.cfg.urgent) return this.raise(top, 'urgent', p.atMs);

    const words = tokens(p.text);
    const last = words[words.length - 1] ?? '';
    const atBoundary = BOUNDARY.has(last) || gap >= this.cfg.breathMs;
    if (top.urge >= this.threshold && atBoundary) return this.raise(top, 'boundary', p.atMs);

    if (top.urge >= 0.3 && (!this.queued || top.urge > this.queued.urge)) this.queued = top;
    return { kind: 'listen' };
  }

  /** A stance gets maxPushes per disagreement. After that it may hold its view; it may not raise it. */
  private hadItsSay(t: Thread): boolean {
    return !!t.stance && t.stance.pushes >= this.maxPushes;
  }

  private urges(p: Heard, ctx: DetectCtx): Urge[] {
    const out: Urge[] = [];
    for (const t of this.threads) {
      if (this.hadItsSay(t)) continue;
      if (t.lastRaisedMs !== null && p.atMs - t.lastRaisedMs < this.cfg.restMs) continue;
      let best: Urge | null = null;
      for (const d of this.cfg.detectors) {
        const u = d(p, t, ctx);
        if (u && (!best || u.urge > best.urge)) best = u;
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => b.urge - a.urge);
  }

  private raise(u: Urge, how: 'boundary' | 'urgent' | 'queue', atMs: number): Decision {
    u.thread.lastRaisedMs = atMs;
    if (u.thread.stance) u.thread.stance.pushes++;
    if (how === 'queue') return { kind: 'queue', urge: u };
    return { kind: 'interrupt', urge: u, at: how };
  }

  /** It has the floor, and something came in. A turn, or a nod? */
  private floor(p: Heard): Decision {
    const text = p.text.toLowerCase().trim();
    const words = tokens(text);
    const takes = TAKE_FLOOR.find((w) => new RegExp(`(^|\\s)${w}(\\s|$|[,.!?])`).test(text));
    if (takes) return { kind: 'yield', why: `"${takes}"` };
    if (words.length > 0 && words.every((w) => BACKCHANNEL.has(w))) return { kind: 'keep' };
    if (words.length >= 3) return { kind: 'yield', why: 'they started a sentence' };
    return { kind: 'keep' };
  }

  // ----------------------------------------------------------------- arguing

  /**
   * The person answered a point it raised. What happens to the stance?
   *
   * Order matters: an override is checked before a reason, because "I know,
   * but do it anyway" is an override that happens to contain a "but".
   */
  reply(threadId: string, text: string): Reply {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t?.stance) {
      if (t) t.resolved = true;
      return 'no-stance';
    }
    const s = t.stance;
    const lower = text.toLowerCase();

    if (OVERRIDE.some((r) => r.test(lower)) && !AGREE.some((r) => r.test(lower))) {
      s.overridden = true;
      t.resolved = true;
      return 'overridden';
    }
    if (AGREE.some((r) => r.test(lower))) {
      t.resolved = true;
      return 'agreed';
    }
    if (REASON.some((r) => r.test(lower)) || numberIn(text) !== null) {
      s.confidence = Math.max(0, s.confidence - 0.35);
      s.evidence.push(`they said: ${text}`);
      if (s.confidence < 0.4) {
        s.conceded = true;
        t.resolved = true;
        return 'conceded';
      }
    }
    // Still standing. Whether it may push again is `hadItsSay`, checked
    // wherever an urge is formed — not a timestamp pushed into the future.
    return 'holding';
  }

  /**
   * A raised contradiction was answered: this is the value that stands now.
   * The only way a claim changes by more than a revision.
   */
  settle(threadId: string, value: number, text: string, atMs: number): void {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t) return;
    t.value = value;
    t.said = { text, atMs };
    t.resolved = false; // still a live claim, now at its new value
    t.lastRaisedMs = atMs;
  }

  /** New evidence reopens an overridden stance. Nothing else does. */
  reopen(threadId: string, evidence: string, atMs: number): boolean {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t?.stance) return false;
    t.stance.evidence.push(evidence);
    t.stance.overridden = false;
    t.stance.conceded = false;
    t.stance.pushes = 0;
    t.resolved = false;
    t.lastRaisedMs = null;
    t.weight = 1;
    t.said = { text: evidence, atMs };
    return true;
  }

  // --------------------------------------------------------------- wandering

  /**
   * Called on a tick. If it has been quiet long enough and nothing is on
   * stage, go back to something left open — the heaviest unresolved thread
   * that is not resting.
   */
  wander(nowMs: number, stageBusy: boolean): Urge | null {
    if (stageBusy) return null;
    if (nowMs - this.lastHeardMs < this.cfg.idleMs) return null;
    this.decay(nowMs);
    const open = this.threads
      .filter((t) => !t.resolved && !t.stance?.overridden && !t.stance?.conceded && !this.hadItsSay(t))
      .filter((t) => t.lastRaisedMs === null || nowMs - t.lastRaisedMs >= this.cfg.restMs)
      .filter((t) => t.weight >= 0.2)
      .sort((a, b) => b.weight - a.weight);
    const t = open[0];
    if (!t) return null;
    t.lastRaisedMs = nowMs;
    this.lastHeardMs = nowMs; // wandering counts as a turn; it does not wander twice in a row
    return {
      thread: t, reason: 'return', urge: Math.min(1, t.weight / 2),
      say: t.stance ? `Going back to ${t.topic}: ${t.stance.position}` : `Going back to what you said about ${t.topic}.`,
    };
  }

  private decayedAt = 0;
  private decay(nowMs: number): void {
    if (this.decayedAt === 0) { this.decayedAt = nowMs; return; }
    const dt = nowMs - this.decayedAt;
    if (dt <= 0) return;
    const f = Math.pow(0.5, dt / this.cfg.halfLifeMs);
    for (const t of this.threads) t.weight *= f;
    this.decayedAt = nowMs;
  }
}
