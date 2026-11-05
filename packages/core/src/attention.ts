/**
 * The attention gate. Spec v0.2 §5.
 *
 * Silence only means assent when the user perceived the proposal, could object,
 * and knew objection was expected. None of that is directly measurable, so the
 * gate is a conjunction of signals that are. Any unknown signal counts as failed.
 */

import type { AttentionState } from './types.js';

export type GateResult = { pass: boolean; failures: string[] };

export const UNKNOWN_ATTENTION: AttentionState = {
  foreground: false,
  unlocked: false,
  proximityClear: false,
  listening: false,
};

export function attentionGate(a: AttentionState | undefined, engagedThisAct: boolean): GateResult {
  const s = a ?? UNKNOWN_ATTENTION;
  const failures: string[] = [];
  if (!s.foreground) failures.push('app not in foreground');
  if (!s.unlocked) failures.push('device locked');
  if (!s.proximityClear) failures.push('proximity sensor covered');
  if (!s.listening) failures.push('not listening, so a veto could not be heard');
  if (!engagedThisAct) failures.push('user has not touched or spoken during this act');
  return { pass: failures.length === 0, failures };
}
