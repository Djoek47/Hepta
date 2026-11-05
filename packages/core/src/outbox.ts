/**
 * The outbox. Spec v0.2 §7.
 *
 * Silence-assent is only honest if undo actually reverses everything. Effects
 * that leave the device (a push, a message, a webhook) cannot be recalled, so
 * they wait here until the undo window closes.
 */

import type { Clock, TimerId } from './clock.js';
import type { CommitResult, Ctx, EffectDef } from './types.js';

export const UNDO_WINDOW_MS = 5000;

export type OutboxRecord = {
  id: string;
  act: string;
  result: CommitResult;
  /** Wall-clock epoch ms, so a restore after relaunch keeps the remaining time. */
  deadlineAt: number;
  /**
   * Which effects were queued. Recorded because when() was evaluated against
   * the filled slots at commit time, which no longer exist after a relaunch.
   */
  effectNames: string[];
};

type Live = OutboxRecord & { effects: EffectDef[]; timer: TimerId | null };

export type OutboxEvents = {
  onFire?: (rec: OutboxRecord) => void;
  onEffectError?: (rec: OutboxRecord, effect: EffectDef, err: unknown) => void;
};

export class Outbox {
  private entries = new Map<string, Live>();
  private seq = 1;

  constructor(
    private readonly clock: Clock,
    private readonly ctx: () => Ctx,
    private readonly events: OutboxEvents = {},
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Hold effects for `windowMs`. Returns the entry id, which undo() cancels. */
  add(act: string, result: CommitResult, effects: EffectDef[], windowMs: number): string {
    const id = `ob_${this.seq++}`;
    const deadlineAt = this.clock.now() + windowMs;
    const effectNames = effects.map((e, i) => e.name ?? `effect[${i}]`);
    const live: Live = { id, act, result, deadlineAt, effectNames, effects, timer: null };
    live.timer = this.clock.setTimeout(() => void this.fire(id), windowMs);
    this.entries.set(id, live);
    return id;
  }

  /** Undo inside the window: discard, never fire. */
  cancel(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.timer !== null) this.clock.clearTimeout(e.timer);
    this.entries.delete(id);
    return true;
  }

  private async fire(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    const ctx = this.ctx();
    for (const effect of e.effects) {
      try {
        await effect.run(e.result, ctx);
      } catch (err) {
        // A failed effect is reported. It does NOT reverse the commit. §7
        this.events.onEffectError?.(e, effect, err);
      }
    }
    this.events.onFire?.(e);
  }

  /** Persist across a kill. Effects are re-attached by act name on restore. */
  serialize(): OutboxRecord[] {
    return [...this.entries.values()].map(({ id, act, result, deadlineAt, effectNames }) => ({
      id,
      act,
      result,
      deadlineAt,
      effectNames,
    }));
  }

  /**
   * Resume after relaunch with the REMAINING time. An overdue entry fires at
   * once — that is late, never early.
   */
  restore(records: OutboxRecord[], effectsFor: (act: string, names: string[]) => EffectDef[]): void {
    for (const rec of records) {
      const remaining = Math.max(0, rec.deadlineAt - this.clock.now());
      const live: Live = { ...rec, effects: effectsFor(rec.act, rec.effectNames), timer: null };
      live.timer = this.clock.setTimeout(() => void this.fire(rec.id), remaining);
      this.entries.set(rec.id, live);
    }
  }
}
