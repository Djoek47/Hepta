/**
 * The smallest App the pyramid tests need, standing in for
 * @intermenu/aiuic-kit's createApp (not ported: see the App seam in
 * src/index.ts). `hear()` is the kit's final-sentence path, line for line;
 * there is no speculator, no presenter and no menu here, because nothing in
 * these tests uses them.
 */
import {
  createAIUIC, defineAct, type ActDef, type ActRun, type AIUIC, type Clock, type Ctx, type Option,
} from '@intermenu/aiuic-core';
import { DEFAULT_ROUTING, LocalResolver, pickAct } from '@intermenu/aiuic-resolve';

export type MiniAppConfig = {
  acts: ActDef[];
  ctx: () => Omit<Ctx, 'now'> & { now?: Date };
  clock?: Clock;
  /** Accepted for parity with the kit; there is no speculator here. */
  speculate?: boolean;
};

export class MiniApp {
  readonly ui: AIUIC;
  private readonly resolver = new LocalResolver(DEFAULT_ROUTING);

  constructor(private readonly config: MiniAppConfig) {
    this.ui = createAIUIC({ ...(config.clock ? { clock: config.clock } : {}), ctx: () => this.ctx() });
    for (const a of config.acts) this.ui.defineAct(a);
  }

  private ctx(): Ctx {
    const base = this.config.ctx();
    return { ...base, now: base.now ?? new Date() } as Ctx;
  }

  optionsFor(act: ActDef, slot: string): Option[] {
    const got = act.slots[slot]?.options?.(this.ctx(), {});
    return Array.isArray(got) ? got : [];
  }

  get act(): ActRun | null {
    return this.ui.act;
  }

  hear(text: string): void {
    const ctx = this.ctx();
    const defs = this.ui.definitions;
    const scores = this.resolver.scoreSync(text, defs, ctx, (a, s) => this.optionsFor(a, s));
    const decision = pickAct(scores, DEFAULT_ROUTING);
    if (decision.kind === 'none') return;
    const name = decision.kind === 'start' ? decision.act : decision.acts[0]!;
    const def = defs.find((d) => d.name === name)!;
    const run = this.ui.start(name);
    const cands = this.resolver.fillSync(text, def, {}, ctx, (a, s) => this.optionsFor(a, s));
    for (const [slot, list] of Object.entries(cands)) if (list.length > 0) run.offer(slot, list, 'spoken');
    if (decision.kind === 'start') run.markEngaged();
    run.evaluate();
  }

  /** The stage as the tests read it: each slot's name and value. */
  view(): { slots: { name: string; value: unknown }[] } | null {
    const run = this.act;
    if (!run) return null;
    return { slots: Object.entries(run.state().slots).map(([name, s]) => ({ name, value: s.value })) };
  }

  reset(): void {}
  draw(): void {}
}

export function createApp(config: MiniAppConfig): MiniApp {
  return new MiniApp(config);
}

export { defineAct };
