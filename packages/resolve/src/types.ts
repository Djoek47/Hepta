/**
 * The resolver contract. Spec v0.2 §3 and §8.
 *
 * Resolution runs in tiers, and the tier is what makes the local-first claim
 * true or false:
 *
 *   tier 0  local      0 ms      offline   exact and fuzzy over declared options
 *   tier 1  Jev        70-500ms  network   typed decisions with calibrated confidence
 *   tier 2  LLM        seconds   network   free text, novel intent, escalation
 *
 * `local: false` marks a resolver the degraded path must never depend on.
 */

import type { ActDef, Candidate, Ctx, Filled, Option } from '@intermenu/aiuic-core';

export type ActScore = {
  act: string;
  score: number;
  phraseMatch: number;
  requiredCoverage: number;
};

export type SlotCandidates = Record<string, Candidate[]>;

export type OptionsFor = (act: ActDef, slot: string) => Option[];

export interface Resolver {
  readonly name: string;
  /** True only if it runs on device with no network. */
  readonly local: boolean;
  /**
   * Whether this tier's scores are calibrated probabilities. False for anything
   * that reads a softmax over option tokens out of a general model: that number
   * looks like confidence and is not. An uncalibrated tier may fill a slot, but
   * the fill stays provisional, so it can never silence-commit at
   * 'other-person' or above.
   */
  readonly calibrated: boolean;
  score(text: string, acts: ActDef[], ctx: Ctx, optionsFor: OptionsFor): Promise<ActScore[]>;
  fill(
    text: string,
    act: ActDef,
    filled: Filled,
    ctx: Ctx,
    optionsFor: OptionsFor,
  ): Promise<SlotCandidates>;
}

/** §3 routing thresholds. Defaults to tune against real utterances, not claims. */
export type RoutingConfig = {
  tauAct: number;
  deltaAct: number;
  /** Coverage counts a slot only when a candidate clears this. */
  tauFill: number;
  phraseWeight: number;
  coverageWeight: number;
  /**
   * A trigger phrase either matched or it did not. Short words are one edit
   * from each other — "pay" scores 0.75 against "play" — and treating that as
   * partial evidence routes "play something" to a payment act.
   */
  phraseFloor: number;
  /**
   * Coverage given to an act with nothing checkable to cover — only free
   * text, or no required slots. Scoring it on its phrase alone gave it a
   * perfect score, so "add milk" (groceries: asks only for free text) beat
   * "add the dishes for Maya tomorrow" (chores: a person and a time, both
   * found) whenever the two shared the word "add". Absence of evidence is
   * weak evidence against, not none. 0.35 still lost the chores case by a
   * hundredth once rival acts discounted its evidence; 0.25 is the value the
   * routing test in test/uncheckable.test.ts holds in place.
   */
  uncheckableCoverage: number;
};

export const DEFAULT_ROUTING: RoutingConfig = {
  tauAct: 0.5,
  deltaAct: 0.15,
  tauFill: 0.85,
  phraseWeight: 0.4,
  coverageWeight: 0.6,
  phraseFloor: 0.9,
  uncheckableCoverage: 0.25,
};

export type RouteDecision =
  | { kind: 'start'; act: string; scores: ActScore[] }
  | { kind: 'narrow'; acts: string[]; scores: ActScore[] }
  | { kind: 'none'; scores: ActScore[] };
