/**
 * One live act. Spec v0.2 §2, §4, §5, §6, §7.
 *
 * This is the state machine the whole method rests on. It never renders and it
 * never parses text: it takes structured slot fills and decides what may commit,
 * how, and when.
 */

import type { Clock, TimerId } from './clock.js';
import { attentionGate, type GateResult } from './attention.js';
import { slotOrder } from './define.js';
import { Outbox, UNDO_WINDOW_MS } from './outbox.js';
import { effectiveRadius, holdDurationMs } from './radius.js';
import type {
  ActDef,
  ActStatus,
  AssentChannel,
  Candidate,
  CommitResult,
  Ctx,
  Filled,
  Phase,
  Radius,
  SlotSource,
  SlotState,
  StageState,
} from './types.js';
import { radiusRank } from './types.js';

/** §8. A local fill is CONFIRMED when it is clearly the best match. */
export const TAU_FILL = 0.85;
export const DELTA_FILL = 0.15;

export type FillOutcome = 'filled' | 'narrowed' | 'empty';

/**
 * Copy slot state for reporting. Deliberately shallow over `value`: a slot's
 * value is a host object and may be a class instance — cloning it would hand
 * the model a different object than the one commit() will receive.
 */
export function cloneSlots(slots: Record<string, SlotState>): Record<string, SlotState> {
  const out: Record<string, SlotState> = {};
  for (const [k, s] of Object.entries(slots)) {
    out[k] = s.candidates ? { ...s, candidates: s.candidates.map((c) => ({ ...c })) } : { ...s };
  }
  return out;
}

export function classify(
  candidates: Candidate[],
  tau = TAU_FILL,
  delta = DELTA_FILL,
): { outcome: FillOutcome; value?: unknown; provisional: boolean; ranked: Candidate[] } {
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return { outcome: 'empty', provisional: false, ranked };
  const second = ranked[1];
  const lead = best.score - (second?.score ?? 0);

  // An uncalibrated score can never confirm a slot. It may fill it, so the
  // stage paints and the user can correct it, but it stays provisional — which
  // means it cannot silence-commit anything at 'other-person' or above.
  const trustworthy = best.calibrated !== false;

  if (best.score >= tau && lead >= delta) {
    return { outcome: 'filled', value: best.value, provisional: !trustworthy, ranked };
  }
  if (second && lead < delta) {
    // Two live candidates: that is a narrowed slot, not a filled one.
    return { outcome: 'narrowed', provisional: true, ranked };
  }
  // One weak candidate: fill it, but say so.
  return { outcome: 'filled', value: best.value, provisional: true, ranked };
}

export type ActEvent =
  | { type: 'stage'; state: StageState }
  | { type: 'hold-start'; act: string; ms: number; radius: Radius }
  | { type: 'hold-cancel'; act: string; reason: string }
  | { type: 'commit'; act: string; result: CommitResult; undoId: string | null }
  | { type: 'undo'; act: string; result: CommitResult }
  | { type: 'failed'; act: string; error: unknown }
  | { type: 'discarded'; act: string }
  | { type: 'frozen'; act: string; reason: string }
  | { type: 'blocked'; act: string; reason: string; failures?: string[] };

export type Emit = (e: ActEvent) => void;

export class ActRun {
  readonly def: ActDef;
  status: ActStatus = 'resolving';
  phase: Phase = 'show';
  slots: Record<string, SlotState> = {};
  result: CommitResult | null = null;
  undoId: string | null = null;

  /**
   * Speculation. A stage painted from a PARTIAL utterance may show everything
   * it has worked out, and may not commit any of it: the speaker has not
   * stopped talking, so there is no silence to read as assent. Clearing this
   * is the moment the tongue stops turning.
   */
  speculative = false;

  private holdTimer: TimerId | null = null;
  private holdEndsAt = 0;
  private holdMs = 0;
  private engaged = false;

  constructor(
    def: ActDef,
    private readonly clock: Clock,
    private readonly ctxOf: () => Ctx,
    private readonly outbox: Outbox,
    private readonly emit: Emit,
  ) {
    this.def = def;
    for (const name of Object.keys(def.slots)) {
      this.slots[name] = { status: 'empty', provisional: false };
    }
    this.applyDefaults();
  }

  // ---------------------------------------------------------------- reading

  get filled(): Filled {
    const out: Filled = {};
    for (const [name, s] of Object.entries(this.slots)) {
      if (s.status === 'filled') out[name] = s.value;
    }
    return out;
  }

  get radius(): Radius {
    return effectiveRadius(this.def, this.filled, this.ctxOf());
  }

  private get requiredNames(): string[] {
    return slotOrder(this.def).filter((n) => this.def.slots[n]?.required === true);
  }

  private get missingRequired(): string[] {
    return this.requiredNames.filter((n) => this.slots[n]?.status !== 'filled');
  }

  state(): StageState {
    const live = this.status !== 'settled' && this.status !== 'discarded';
    const gate = attentionGate(this.ctxOf().attention, this.engaged);
    const radius = live ? this.radius : null;
    const next = this.missingRequired[0];
    const base: StageState = {
      act: this.def.name,
      status: this.status,
      phase: this.phase,
      slots: cloneSlots(this.slots),
      radius,
      assent:
        this.status === 'hold'
          ? ('silence' satisfies AssentChannel)
          : this.status === 'explicit'
            ? ('explicit' satisfies AssentChannel)
            : null,
      visible: this.status === 'resolving' && next ? [next] : slotOrder(this.def),
      outbox: this.outbox.size,
    };
    if (this.status === 'hold') {
      base.holdRemainingMs = Math.max(0, this.holdEndsAt - this.clock.now());
    }
    if (next) base.focus = next;
    if (!gate.pass) base.gateFailures = gate.failures;
    return base;
  }

  // ---------------------------------------------------------------- writing

  private applyDefaults(): void {
    const ctx = this.ctxOf();
    for (const [name, def] of Object.entries(this.def.slots)) {
      if (!def.default) continue;
      const s = this.slots[name];
      if (!s || s.status !== 'empty') continue;
      const value = def.default(ctx, this.filled);
      if (value === undefined) continue;
      this.slots[name] = { status: 'filled', value, source: 'default', provisional: false };
    }
  }

  /** The user spoke or touched something. Required for the attention gate. */
  markEngaged(): void {
    this.engaged = true;
  }

  setValue(name: string, value: unknown, source: SlotSource): void {
    if (!this.def.slots[name]) throw new Error(`[${this.def.name}] unknown slot "${name}"`);
    if (source === 'spoken' || source === 'touched') this.markEngaged();

    const wasHolding = this.status === 'hold';
    const prev = this.slots[name];
    const changed = prev?.status !== 'filled' || prev.value !== value;

    // An explicit value is confirmed by definition. `provisional` exists for
    // low-confidence LOCAL matches only — a model that names a value IS the
    // authority, so a model fill clears the flag rather than setting it.
    this.slots[name] = {
      status: 'filled',
      value,
      source,
      provisional: false,
      ...(source === 'model' && wasHolding && changed ? { corrected: true } : {}),
    };

    // A frozen act comes back to life when the user points at the problem.
    if (this.status === 'frozen' && (source === 'touched' || source === 'spoken')) {
      this.status = 'resolving';
    }

    if (wasHolding && changed) {
      this.cancelHold('slot changed under a running HOLD');
    }
    this.evaluate();
  }

  offer(name: string, candidates: Candidate[], source: SlotSource): void {
    if (!this.def.slots[name]) throw new Error(`[${this.def.name}] unknown slot "${name}"`);
    if (source === 'spoken' || source === 'touched') this.markEngaged();

    const wasHolding = this.status === 'hold';
    const c = classify(candidates);

    if (c.outcome === 'empty') {
      this.slots[name] = { status: 'empty', provisional: false };
    } else if (c.outcome === 'narrowed') {
      this.slots[name] = { status: 'narrowed', candidates: c.ranked, provisional: true, source };
    } else {
      this.slots[name] = {
        status: 'filled',
        value: c.value,
        source,
        provisional: c.provisional,
        candidates: c.ranked.length > 1 ? c.ranked : undefined,
      };
    }

    if (this.status === 'frozen' && (source === 'touched' || source === 'spoken')) {
      this.status = 'resolving';
    }
    if (wasHolding) this.cancelHold('slot changed under a running HOLD');
    this.evaluate();
  }

  /** Resume checks: options or snapshot moved under a filled value. §8 */
  markStale(name: string): void {
    const s = this.slots[name];
    if (!s) return;
    this.slots[name] = { ...s, stale: true };
    if (this.status === 'hold') this.cancelHold('a filled value went stale');
    this.evaluate();
  }

  // ---------------------------------------------------------------- repair

  /** Bare "no": cancel the commit, freeze the preview, resolve nothing. §6 */
  freeze(reason = 'bare negation'): void {
    if (this.status === 'settled' || this.status === 'discarded') return;
    this.markEngaged();
    this.cancelHold(reason);
    this.status = 'frozen';
    this.phase = 'frozen';
    this.emit({ type: 'frozen', act: this.def.name, reason });
    this.emit({ type: 'stage', state: this.state() });
  }

  discard(): void {
    this.cancelHold('vetoed');
    this.status = 'discarded';
    this.emit({ type: 'discarded', act: this.def.name });
  }

  /** Hangup pauses; it never undoes. A frozen HOLD survives and resumes. */
  pause(): void {
    if (this.status === 'hold') this.cancelHold('paused');
    if (this.status !== 'settled' && this.status !== 'discarded') this.status = 'frozen';
  }

  resume(): void {
    if (this.status !== 'frozen') return;
    this.status = 'resolving';
    this.evaluate();
  }

  // ------------------------------------------------------------- lifecycle

  evaluate(): void {
    if (['committing', 'settled', 'discarded', 'failed'].includes(this.status)) return;
    if (this.status === 'frozen') {
      this.emit({ type: 'stage', state: this.state() });
      return;
    }

    const ctx = this.ctxOf();
    const missing = this.missingRequired;

    if (missing.length > 0) {
      this.status = 'resolving';
      const name = missing[0]!;
      const s = this.slots[name]!;
      this.phase = s.status === 'narrowed' ? 'narrow' : 'unfold';
      this.emit({ type: 'stage', state: this.state() });
      return;
    }

    const stale = Object.entries(this.slots).find(([, s]) => s.stale);
    if (stale) {
      this.status = 'resolving';
      this.phase = 'show';
      this.emit({ type: 'blocked', act: this.def.name, reason: `slot "${stale[0]}" is stale` });
      this.emit({ type: 'stage', state: this.state() });
      return;
    }

    const radius = this.radius;

    // §8: consequential acts wait for confirmation; low-stakes ones do not.
    const provisionalRequired = this.requiredNames.filter((n) => this.slots[n]?.provisional);
    if (provisionalRequired.length > 0 && radiusRank(radius) >= radiusRank('other-person')) {
      this.status = 'resolving';
      this.phase = 'show';
      this.emit({
        type: 'blocked',
        act: this.def.name,
        reason: `provisional ${provisionalRequired.join(', ')} at radius "${radius}"`,
      });
      this.emit({ type: 'stage', state: this.state() });
      return;
    }

    if (this.speculative) {
      this.status = 'speculating';
      this.phase = 'show';
      this.emit({ type: 'stage', state: this.state() });
      return;
    }

    const gate: GateResult = attentionGate(ctx.attention, this.engaged);

    // Handing the assistant more power is never consented to by silence,
    // whatever it costs. Found by the settings tests: "act while I am away"
    // is radius 'self' (it touches nobody else), so it held and committed on
    // a pause — and `grantsAuthority` had only ever been checked against the
    // conductor, never against a quiet person who had not actually said yes.
    if (radius === 'external' || this.def.grantsAuthority || !gate.pass) {
      this.status = 'explicit';
      this.phase = 'explicit';
      this.emit({
        type: 'blocked',
        act: this.def.name,
        reason: radius === 'external' ? 'radius is external'
          : this.def.grantsAuthority ? 'it grants authority, which silence never does' : 'attention gate failed',
        ...(gate.pass ? {} : { failures: gate.failures }),
      });
      this.emit({ type: 'stage', state: this.state() });
      return;
    }

    this.startHold(radius);
  }

  private startHold(radius: Radius): void {
    const ms = holdDurationMs(radius, this.ctxOf());
    this.cancelHold('restart', true);
    this.status = 'hold';
    this.phase = 'hold';
    this.holdMs = ms;
    this.holdEndsAt = this.clock.now() + ms;
    this.holdTimer = this.clock.setTimeout(() => {
      this.holdTimer = null;
      // The hold was granted for the world as it was when it started. Check
      // again at the moment it fires: if what it costs has changed (a
      // delegation revoked, an effect now reaching someone) or silence no
      // longer counts (the device locked, the app went to the background),
      // it goes back through evaluate() instead of committing.
      const ctx = this.ctxOf();
      const now = effectiveRadius(this.def, this.filled, ctx);
      const gate = attentionGate(ctx.attention, this.engaged);
      if (now !== radius || !gate.pass || this.speculative) {
        this.emit({ type: 'hold-cancel', act: this.def.name,
          reason: !gate.pass ? 'silence no longer counts' : now !== radius ? `the cost changed to "${now}"` : 'speech resumed' });
        this.evaluate();
        return;
      }
      void this.commit('silence');
    }, ms);
    this.emit({ type: 'hold-start', act: this.def.name, ms, radius });
    this.emit({ type: 'stage', state: this.state() });
  }

  private cancelHold(reason: string, silent = false): void {
    if (this.holdTimer !== null) {
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
      if (!silent) this.emit({ type: 'hold-cancel', act: this.def.name, reason });
    }
    this.holdEndsAt = 0;
  }

  get holdDurationMsValue(): number {
    return this.holdMs;
  }

  /**
   * The person started talking again after a sentence that had ended. What
   * is on the stage goes back to being a reading of speech in progress: the
   * hold stops, and nothing commits until the new sentence ends too.
   */
  resumeSpeculation(): void {
    if (this.speculative) return;
    if (this.status === 'settled' || this.status === 'committing' || this.status === 'discarded' || this.status === 'failed') return;
    this.speculative = true;
    this.cancelHold('speech resumed');
    this.evaluate();
  }

  /** Speech settled. The act may now be judged on the contract like any other. */
  settleSpeculation(): void {
    if (!this.speculative) return;
    this.speculative = false;
    this.evaluate();
  }

  /**
   * Assent given in advance, by a standing order the person wrote — used by
   * the conductor, never by a person's tap. It does not count as the person
   * engaging with this act, and it refuses outright for an act that grants
   * authority: permission to act without the person is the one thing that
   * can never be granted without the person.
   */
  async assentUnattended(): Promise<void> {
    if (this.def.grantsAuthority) {
      throw new Error(`[${this.def.name}] changes what may happen without the person, so only the person can commit it`);
    }
    if (this.speculative) throw new Error(`[${this.def.name}] cannot assent to a speculative act`);
    if (this.status !== 'explicit' && this.status !== 'hold') {
      throw new Error(`[${this.def.name}] nothing to assent to (status "${this.status}")`);
    }
    if (this.missingRequired.length > 0) {
      throw new Error(`[${this.def.name}] required slots unfilled: ${this.missingRequired.join(', ')}`);
    }
    this.cancelHold('assent from a standing order', true);
    await this.commit('explicit');
  }

  /** Explicit assent: a tap or a yes-word. The only path for `external`. */
  async assent(): Promise<void> {
    this.markEngaged();
    if (this.speculative) {
      throw new Error(`[${this.def.name}] cannot assent to a speculative act; settle it first`);
    }
    if (this.status !== 'explicit' && this.status !== 'hold' && this.status !== 'frozen') {
      throw new Error(`[${this.def.name}] nothing to assent to (status "${this.status}")`);
    }
    if (this.missingRequired.length > 0) {
      throw new Error(`[${this.def.name}] required slots unfilled: ${this.missingRequired.join(', ')}`);
    }
    this.cancelHold('explicit assent', true);
    await this.commit('explicit');
  }

  private async commit(channel: AssentChannel): Promise<void> {
    if (this.status === 'committing' || this.status === 'settled') return;
    this.status = 'committing';
    const ctx = this.ctxOf();
    const filled = this.filled;

    try {
      const result = await this.def.commit(filled, ctx);
      this.result = result;
      this.status = 'settled';
      this.phase = 'settle';

      // An effect gated off by when() neither runs nor counts toward radius.
      const effects = (this.def.effects ?? []).filter((e) => !e.when || e.when(filled, ctx));
      const deferrable = effects.filter((e) => e.deferrable);
      const immediate = effects.filter((e) => !e.deferrable);

      if (deferrable.length > 0) {
        const windowMs = ctx.undoWindowMs ?? UNDO_WINDOW_MS;
        this.undoId = this.outbox.add(this.def.name, result, deferrable, windowMs);
      } else if (this.def.undo) {
        // Nothing to hold, but undo is still offered for the window.
        this.undoId = this.outbox.add(this.def.name, result, [], ctx.undoWindowMs ?? UNDO_WINDOW_MS);
      }

      // Non-deferrable effects only exist on `external` acts, which reached
      // here through explicit assent. They fire now.
      for (const e of immediate) {
        if (channel !== 'explicit') continue;
        await e.run(result, ctx);
      }

      this.emit({ type: 'commit', act: this.def.name, result, undoId: this.undoId });
      this.emit({ type: 'stage', state: this.state() });
    } catch (error) {
      this.status = 'failed';
      this.emit({ type: 'failed', act: this.def.name, error });
      this.emit({ type: 'stage', state: this.state() });
    }
  }

  /** One tap on the settle mark. No dialog. §7 */
  async undo(): Promise<boolean> {
    if (this.status !== 'settled' || !this.result) return false;
    if (!this.undoId || !this.outbox.has(this.undoId)) return false; // window closed
    this.outbox.cancel(this.undoId);
    this.undoId = null;
    await this.def.undo?.(this.result, this.ctxOf());
    this.emit({ type: 'undo', act: this.def.name, result: this.result });
    return true;
  }

  get undoAvailable(): boolean {
    return this.status === 'settled' && !!this.undoId && this.outbox.has(this.undoId);
  }
}
