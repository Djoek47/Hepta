/**
 * The AIUIC facade. Spec v0.2 §10.
 *
 * The core takes structured slot fills, not text and not audio. Routing and
 * matching live in @intermenu/aiuic-resolve; speech lives outside the SDK.
 */

import { ActRun, type ActEvent } from './act-run.js';
import { realClock, type Clock } from './clock.js';
import { defineAct, requiresModel } from './define.js';
import { Outbox, type OutboxRecord } from './outbox.js';
import type { ActDef, Ctx, StageState } from './types.js';

export type AIUICConfig = {
  /** Host context. `now` is overridden from the clock so tests can move time. */
  ctx: () => Omit<Ctx, 'now'> & { now?: Date };
  clock?: Clock;
};

const IDLE: StageState = {
  act: null,
  status: 'resolving',
  phase: 'idle',
  slots: {},
  radius: null,
  assent: null,
  visible: [],
  outbox: 0,
};

export class AIUIC {
  private readonly acts = new Map<string, ActDef>();
  private readonly listeners = new Set<(e: ActEvent) => void>();
  private current: ActRun | null = null;
  readonly clock: Clock;
  readonly outbox: Outbox;

  constructor(private readonly config: AIUICConfig) {
    this.clock = config.clock ?? realClock;
    this.outbox = new Outbox(this.clock, () => this.ctx());
  }

  private ctx(): Ctx {
    const base = this.config.ctx();
    return { ...base, now: new Date(this.clock.now()) } as Ctx;
  }

  private emit = (e: ActEvent): void => {
    for (const l of this.listeners) l(e);
  };

  on(listener: (e: ActEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  defineAct(def: ActDef): ActDef {
    const validated = defineAct(def);
    this.acts.set(validated.name, validated);
    return validated;
  }

  get definitions(): ActDef[] {
    return [...this.acts.values()];
  }

  /** True when this act cannot run with the model absent. §8 */
  needsModel(name: string): boolean {
    const def = this.acts.get(name);
    if (!def) throw new Error(`unknown act "${name}"`);
    return requiresModel(def);
  }

  /**
   * Start an act by name. Routing from text is the resolve layer's job.
   *
   * `speculative` has to be settable here rather than on the returned run,
   * because this method evaluates before it returns. Setting it afterwards
   * means the first evaluate runs unguarded: harmless today, since a new run
   * has no engagement and so cannot reach HOLD, but it does paint one frame of
   * "needs a yes" over a sentence the speaker is still in the middle of, and
   * it leaves the safety of the whole speculation path resting on a clause
   * written for a different reason.
   */
  start(name: string, opts: { speculative?: boolean } = {}): ActRun {
    const def = this.acts.get(name);
    if (!def) throw new Error(`unknown act "${name}"`);
    if (this.current && ['resolving', 'hold', 'explicit', 'frozen'].includes(this.current.status)) {
      // One viewport: a new act replaces a live one only after it is resolved.
      this.current.discard();
    }
    const run = new ActRun(def, this.clock, () => this.ctx(), this.outbox, this.emit);
    if (opts.speculative) run.speculative = true;
    this.current = run;
    run.evaluate();
    return run;
  }

  get act(): ActRun | null {
    return this.current;
  }

  state(): StageState {
    return this.current ? this.current.state() : { ...IDLE, outbox: this.outbox.size };
  }

  /** Persist the outbox before the process dies. §7 */
  serializeOutbox(): OutboxRecord[] {
    return this.outbox.serialize();
  }

  restoreOutbox(records: OutboxRecord[]): void {
    this.outbox.restore(records, (act, names) => {
      const effects = this.acts.get(act)?.effects ?? [];
      return effects.filter((e, i) => names.includes(e.name ?? `effect[${i}]`));
    });
  }
}

export function createAIUIC(config: AIUICConfig): AIUIC {
  return new AIUIC(config);
}
