/**
 * Blast radius. Spec v0.2 §4.
 *
 * The rule that makes silence-assent defensible: an act's radius is the
 * MAXIMUM of its commit radius and every effect's radius. A host cannot
 * launder a send through a "reversible draft" commit.
 */

import type { ActDef, Ctx, Filled, Radius, RadiusSpec } from './types.js';
import { maxRadius, radiusRank } from './types.js';

/** The ceiling a host promises at definition time. */
export function staticMax(spec: RadiusSpec): Radius {
  return typeof spec === 'string' ? spec : spec.max;
}

export function commitRadius(def: ActDef, filled: Filled, ctx: Ctx): Radius {
  return typeof def.radius === 'string' ? def.radius : def.radius.of(filled, ctx);
}

export type RadiusBreakdown = {
  radius: Radius;
  commit: Radius;
  /** Set when the act's own radius was raised, and why. */
  why?: string;
  /** Effect name (or index) → the radius it contributed, after coercion. */
  effects: Array<{ name: string; radius: Radius; why?: string }>;
};

export function explainRadius(def: ActDef, filled: Filled, ctx: Ctx): RadiusBreakdown {
  const commit = commitRadius(def, filled, ctx);
  const limit = ctx.reachLimit ?? 1;
  const effects: RadiusBreakdown['effects'] = [];
  let radius = commit;
  let why: string | undefined;

  // defineAct refuses a static max below external with no undo. That check
  // reads the MAX, so an act can declare max "external" and have of() return
  // "self" at runtime — which passed definition and then silence-committed
  // with nothing to take it back. Every radius passes through here, so the
  // same rule is held here at runtime: no undo, no silence.
  if (!def.undo && radiusRank(radius) < radiusRank('external')) {
    radius = 'external';
    why = 'no undo() — nothing could take it back, so it cannot commit on silence';
  }

  (def.effects ?? []).forEach((e, i) => {
    const name = e.name ?? `effect[${i}]`;

    // An effect that will not run cannot cost anything.
    if (e.when && !e.when(filled, ctx)) {
      effects.push({ name, radius: 'self', why: 'skipped by when()' });
      return;
    }

    let r = e.radius;
    let why: string | undefined;

    if (!e.reversible && radiusRank(r) < radiusRank('external')) {
      r = 'external';
      why = 'effect is irreversible';
    }

    if (e.reach) {
      const n = e.reach(filled, ctx);
      if (n > limit) {
        r = 'external';
        why = `reach ${n} exceeds reachLimit ${limit}`;
      }
    }

    effects.push(why ? { name, radius: r, why } : { name, radius: r });
    radius = maxRadius(radius, r);
  });

  return why ? { radius, commit, effects, why } : { radius, commit, effects };
}

export function effectiveRadius(def: ActDef, filled: Filled, ctx: Ctx): Radius {
  return explainRadius(def, filled, ctx).radius;
}

/** §4. HOLD duration = basePause(actor) × radiusMultiplier(write). Never collapse them. */
export const HOLD_MULTIPLIER: Record<Radius, number> = {
  self: 1.0,
  shared: 1.0,
  'other-person': 1.6,
  external: 0, // external never silence-commits
};

export const BASE_PAUSE_MS = 850;

export function holdDurationMs(radius: Radius, ctx: Ctx): number {
  const base = ctx.actor.basePauseMs ?? BASE_PAUSE_MS;
  return Math.round(base * HOLD_MULTIPLIER[radius]);
}
