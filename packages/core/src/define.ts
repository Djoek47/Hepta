/**
 * Definition-time validation. Spec v0.2 §4.
 *
 * These checks are the whole point of declaring a radius: a host that could
 * silence-commit an irreversible write should fail to start, not fail in the
 * user's hands.
 */

import type { ActDef, SlotDef } from './types.js';
import { radiusRank } from './types.js';
import { staticMax } from './radius.js';

export class ActDefinitionError extends Error {
  readonly act: string;
  constructor(act: string, message: string) {
    super(`[${act}] ${message}`);
    this.name = 'ActDefinitionError';
    this.act = act;
  }
}

const EXTERNAL = radiusRank('external');

export function defineAct(def: ActDef): ActDef {
  const fail = (m: string): never => {
    throw new ActDefinitionError(def.name, m);
  };

  if (!def.name) fail('act needs a name');
  if (!def.commit) fail('act needs a commit function');

  if (typeof def.radius !== 'string') {
    if (!def.radius || typeof def.radius.of !== 'function') {
      fail('a function-valued radius needs { max, of }');
    }
    if (!def.radius.max) {
      fail('a function-valued radius must declare a static max, or it cannot be checked here');
    }
  }

  const max = staticMax(def.radius);
  const below = radiusRank(max) < EXTERNAL;

  const slots = Object.entries(def.slots ?? {});
  if (slots.length === 0) fail('act needs at least one slot');

  const seen = new Set<number>();
  for (const [name, slot] of slots) {
    const s = slot as SlotDef;
    if (!s.primitive) fail(`slot "${name}" needs a primitive`);
    if (typeof s.order !== 'number') fail(`slot "${name}" needs an order`);
    if (seen.has(s.order)) fail(`slot "${name}" reuses order ${s.order}`);
    seen.add(s.order);
    if (!s.options && !s.resolve && !s.default) {
      fail(`slot "${name}" needs options, resolve, or default — nothing can fill it`);
    }
    if (s.fill === 'model' && s.required && below) {
      // Not fatal, but the host should know this act has no degraded mode.
      // Surfaced through requiresModel() rather than thrown.
    }
  }

  // Check 3: below external must be reversible.
  if (below && !def.undo) {
    fail(`radius max "${max}" is below "external" but no undo() is declared; silence-assent requires a reversal`);
  }

  for (const [i, e] of (def.effects ?? []).entries()) {
    const label = e.name ?? `effect[${i}]`;
    if (typeof e.run !== 'function') fail(`${label} needs run()`);
    if (!e.radius) fail(`${label} needs a radius`);
    if (typeof e.reversible !== 'boolean') fail(`${label} needs reversible`);
    if (typeof e.deferrable !== 'boolean') fail(`${label} needs deferrable`);

    // Check 2: a non-deferrable effect cannot be held for the undo window,
    // so the act can never silence-commit.
    if (!e.deferrable && below) {
      fail(`${label} is not deferrable, so it fires before undo is possible; declare radius max "external"`);
    }
    if (!e.reversible && below) {
      fail(`${label} is irreversible; declare radius max "external"`);
    }
    if (radiusRank(e.radius) > radiusRank(max)) {
      fail(`${label} declares radius "${e.radius}" above the act's max "${max}"`);
    }
  }

  return def;
}

/** True when the act cannot run without a model: a required slot is model-filled. §8 */
export function requiresModel(def: ActDef): boolean {
  return Object.values(def.slots).some((s) => s.required === true && s.fill === 'model');
}

export function slotOrder(def: ActDef): string[] {
  return Object.entries(def.slots)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name]) => name);
}
