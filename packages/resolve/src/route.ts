/**
 * Act routing. Spec v0.2 §3.
 *
 * Acts compete for each utterance. A near-tie is not a coin flip: it becomes a
 * NARROW beat over the acts themselves, which is the same repair affordance the
 * method already uses for slots.
 */

import { DEFAULT_ROUTING, type ActScore, type RouteDecision, type RoutingConfig } from './types.js';

export function pickAct(scores: ActScore[], routing: RoutingConfig = DEFAULT_ROUTING): RouteDecision {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < routing.tauAct) return { kind: 'none', scores: ranked };

  const tied = ranked.filter(
    (s) => s.score >= routing.tauAct && top.score - s.score < routing.deltaAct,
  );

  if (tied.length > 1) return { kind: 'narrow', acts: tied.map((s) => s.act), scores: ranked };
  return { kind: 'start', act: top.act, scores: ranked };
}
