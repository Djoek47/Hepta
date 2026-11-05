/**
 * AIUIC core types. Spec v0.2 §2.
 *
 * The core knows no host nouns. Everything domain-specific arrives through
 * a host-declared act schema.
 */

/** §4. Ordered: a higher radius is more costly to get wrong. */
export type Radius = 'self' | 'shared' | 'other-person' | 'external';

export const RADIUS_ORDER = ['self', 'shared', 'other-person', 'external'] as const;

export function radiusRank(r: Radius): number {
  return RADIUS_ORDER.indexOf(r);
}

export function maxRadius(...rs: Radius[]): Radius {
  let out: Radius = 'self';
  for (const r of rs) if (radiusRank(r) > radiusRank(out)) out = r;
  return out;
}

/** §2 beat grammar, plus the two non-beat resting states. */
export type Phase =
  | 'idle'
  | 'show'
  | 'narrow'
  | 'unfold'
  | 'hold'
  | 'explicit'
  | 'frozen'
  | 'settle';

/**
 * Where a slot's value came from. Load-bearing: repair (§6) prefers correcting
 * what the system assumed over what the user said.
 */
export type SlotSource = 'spoken' | 'touched' | 'remembered' | 'default' | 'model';

export type Candidate = {
  value: unknown;
  label?: string;
  /** 0..1. See `calibrated`: a high score is not the same as a trustworthy one. */
  score: number;
  /**
   * Whether `score` is a CALIBRATED probability — one where 0.9 means right
   * about nine times out of ten.
   *
   * An exact string match is calibrated by construction. A softmax over option
   * tokens read out of a general model is not: it is confidently shaped and
   * means nothing in particular. Defaults to true; a producer that cannot make
   * the promise must set it false, and an uncalibrated fill is always
   * provisional however high it scores.
   */
  calibrated?: boolean;
  /** Which tier produced it, for the stage report and for debugging. */
  source?: string;
  /** Character span of the utterance this matched, for overlap arbitration. */
  span?: [start: number, end: number];
};

export type SlotStatus = 'empty' | 'narrowed' | 'filled';

export type SlotState = {
  status: SlotStatus;
  /** Present when narrowed. Persists across pause/resume; NARROW is the beat that shows it. */
  candidates?: Candidate[];
  value?: unknown;
  source?: SlotSource;
  /** Low local score or ambiguous. NOT a synonym for "filled locally". §8 */
  provisional: boolean;
  /** Options or snapshot changed since the value was chosen. Blocks HOLD. */
  stale?: boolean;
  /** A model changed this value under a running HOLD. Never silent. */
  corrected?: boolean;
};

export type PrimitiveName =
  | 'face'
  | 'chip'
  | 'when'
  | 'quantity'
  | 'ghostField'
  | 'objectCard'
  | 'peek'
  | 'holdRing'
  | 'resultMark'
  | (string & {});

export type Filled = Record<string, unknown>;

export type Option = { value: unknown; label: string; aliases?: string[] };

/** §5. Every signal must be known-true; unknown counts as failed. */
export type AttentionState = {
  foreground: boolean;
  unlocked: boolean;
  proximityClear: boolean;
  /** Mic is live. A hung-up session cannot hear a veto. */
  listening: boolean;
};

export type ActorRef = { id: string; basePauseMs?: number };

export type Ctx = {
  now: Date;
  actor: ActorRef;
  attention: AttentionState;
  /** Effects reaching more than this many people force explicit assent. §4 */
  reachLimit?: number;
  undoWindowMs?: number;
  [k: string]: unknown;
};

export type SlotDef = {
  primitive: PrimitiveName;
  params?: Record<string, unknown>;
  /** Primary source of values. The core's matcher runs over these. */
  options?: (ctx: Ctx, filled: Filled) => Option[] | Promise<Option[]>;
  /** Host override for matching. Defaults to the core matcher over `options`. */
  resolve?: (text: string, ctx: Ctx, filled: Filled) => Candidate[];
  /** 'model' slots cannot be filled locally: the act needs a model to run. §8 */
  fill?: 'local' | 'model' | 'either';
  required?: boolean;
  default?: (ctx: Ctx, filled: Filled) => unknown;
  /** Freeze volatile facts (a segment's member count) at fill time. Re-run on resume. */
  snapshot?: (value: unknown, ctx: Ctx) => unknown | Promise<unknown>;
  order: number;
};

export type CommitResult = {
  id: string;
  /** Required for update-style acts: undo has nothing to restore without it. */
  previous?: unknown;
  [k: string]: unknown;
};

export type EffectDef = {
  name?: string;
  run: (r: CommitResult, ctx: Ctx) => void | Promise<void>;
  /**
   * Whether this effect will actually run, given the filled slots. An effect
   * that will not run contributes no radius — otherwise a conditional notify
   * ("unless it's me") escalates every act that declares one.
   */
  when?: (filled: Filled, ctx: Ctx) => boolean;
  radius: Radius;
  /** false coerces the act to 'external' regardless of declared radius. */
  reversible: boolean;
  /** false means it cannot be held in the outbox, so it cannot silence-commit. */
  deferrable: boolean;
  /**
   * How many people or systems this touches. Estimated from FILLED SLOTS, not
   * from CommitResult: assent has to be decided before the commit runs.
   */
  reach?: (filled: Filled, ctx: Ctx) => number;
};

export type RadiusSpec =
  | Radius
  | { max: Radius; of: (filled: Filled, ctx: Ctx) => Radius };

export type ActDef = {
  name: string;
  /** Routing triggers. §3 */
  phrases?: string[];
  /**
   * Which part of the host app this act belongs to. Opaque here: the core
   * never reads it, never branches on it, and ships no list of valid values.
   *
   * It exists so a design system can hold rules against act definitions rather
   * than against rendered output — "groceries has no assignee", "money always
   * confirms" — and have them fail a lint instead of a review. A presentation
   * layer owns the meaning; this is only the tag it hangs on.
   */
  domain?: string;
  /**
   * This act changes what may happen without the person — letting a tool go
   * ahead on silence, writing a standing order. Only a person may commit it:
   * `assentUnattended()` refuses, so no conductor, schedule or model can use
   * one act to grant itself the next.
   */
  grantsAuthority?: boolean;
  slots: Record<string, SlotDef>;
  radius: RadiusSpec;
  commit: (filled: Filled, ctx: Ctx) => CommitResult | Promise<CommitResult>;
  undo?: (r: CommitResult, ctx: Ctx) => void | Promise<void>;
  effects?: EffectDef[];
  /** What the user is actually agreeing to, as one line. Defaults to slots in order. */
  preview?: (filled: Filled, ctx: Ctx) => unknown[];
};

export type AssentChannel = 'silence' | 'explicit';

export type ActStatus =
  | 'resolving'
  /** Painted from a partial utterance. Cannot reach HOLD until speech settles. */
  | 'speculating'
  | 'hold'
  | 'explicit'
  | 'frozen'
  | 'committing'
  | 'settled'
  | 'failed'
  | 'discarded';

/** §10. Sent to the model after every change. The model is behind the stage. */
export type StageState = {
  act: string | null;
  status: ActStatus;
  phase: Phase;
  slots: Record<string, SlotState>;
  radius: Radius | null;
  assent: AssentChannel | null;
  holdRemainingMs?: number;
  /** Slot names currently presented. */
  visible: string[];
  focus?: string;
  outbox: number;
  /** Why silence is not available, when it is not. */
  gateFailures?: string[];
};
