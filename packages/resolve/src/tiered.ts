/**
 * Tiering. Spec v0.2 §8.
 *
 * Local-first is a claim about ORDER, and order is the thing a plain `await`
 * destroys. So the staged calls hand back the local answer SYNCHRONOUSLY, to
 * paint at once, and the refinement as a promise to apply when it lands. If the
 * network answer were awaited before painting, local-first would be a comment
 * rather than a mechanism.
 */

import type { ActDef, Ctx, Filled } from '@intermenu/aiuic-core';
import type { LocalResolver } from './local.js';
import { pickAct } from './route.js';
import {
  DEFAULT_ROUTING,
  type OptionsFor,
  type Resolver,
  type RouteDecision,
  type RoutingConfig,
  type SlotCandidates,
} from './types.js';

export type Staged<T> = {
  /** Tier 0. Already settled. Paint this now. */
  local: T;
  /** Higher tiers. Resolves to the same shape, refined. Never block on it. */
  refine: Promise<T>;
  /** Which tiers actually answered. Empty means the act ran fully offline. */
  answered: Promise<string[]>;
};

function bestScore(c: SlotCandidates, slot: string): number {
  return c[slot]?.[0]?.score ?? 0;
}

export class TieredResolver {
  readonly local: LocalResolver;
  private readonly higher: Resolver[];

  constructor(
    local: LocalResolver,
    higher: Resolver[] = [],
    private readonly routing: RoutingConfig = DEFAULT_ROUTING,
  ) {
    for (const t of higher) {
      if (t.local) {
        throw new Error(`"${t.name}" claims to be local; put it in tier 0, not above it`);
      }
    }
    this.local = local;
    this.higher = higher;
  }

  route(text: string, acts: ActDef[], ctx: Ctx, optionsFor: OptionsFor): Staged<RouteDecision> {
    const local = pickAct(this.local.scoreSync(text, acts, ctx, optionsFor), this.routing);
    const answered: string[] = [];

    const refine = (async (): Promise<RouteDecision> => {
      // Tier 0 was certain. Do not spend a network call to agree with it.
      if (local.kind === 'start') return local;
      let best: RouteDecision = local;
      for (const tier of this.higher) {
        try {
          const d = pickAct(await tier.score(text, acts, ctx, optionsFor), this.routing);
          answered.push(tier.name);
          best = d;
          if (d.kind === 'start') break;
        } catch {
          // A tier that throws is a tier that is absent. Keep what we have.
        }
      }
      return best;
    })();

    return { local, refine, answered: refine.then(() => answered) };
  }

  fill(
    text: string,
    act: ActDef,
    filled: Filled,
    ctx: Ctx,
    optionsFor: OptionsFor,
  ): Staged<SlotCandidates> {
    const local = this.local.fillSync(text, act, filled, ctx, optionsFor);
    const answered: string[] = [];

    // Only REQUIRED slots are worth a network call. An optional slot the local
    // tier could not find is opportunistic; escalating it would spend a call on
    // every utterance that omits a due date.
    const unsure = Object.entries(act.slots)
      .filter(([name, def]) => {
        if (name in filled) return false;
        if (def.fill === 'model') return false;
        if (!def.required) return false;
        return bestScore(local, name) < this.routing.tauFill;
      })
      .map(([name]) => name);

    const refine = (async (): Promise<SlotCandidates> => {
      const out: SlotCandidates = { ...local };
      if (unsure.length === 0 || this.higher.length === 0) return out;
      for (const tier of this.higher) {
        try {
          const answer = await tier.fill(text, act, filled, ctx, optionsFor);
          let used = false;
          for (const name of unsure) {
            const cands = answer[name];
            if (cands && cands.length > 0 && cands[0]!.score > bestScore(out, name)) {
              out[name] = cands;
              used = true;
            }
          }
          if (used) answered.push(tier.name);
        } catch {
          // Tier absent. The local answer stands, and an act whose required
          // slots were confirmed offline still commits.
        }
      }
      return out;
    })();

    return { local, refine, answered: refine.then(() => answered) };
  }

  /** Slots no tier here can fill. These are the LLM's, and they gate degraded mode. */
  modelOnlySlots(act: ActDef): string[] {
    return Object.entries(act.slots)
      .filter(([, def]) => def.fill === 'model')
      .map(([name]) => name);
  }
}
