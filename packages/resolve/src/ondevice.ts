/**
 * Tier 0.5: an on-device option scorer (SemIf / OpenJev style).
 *
 * SemIf runs small open models — Qwen3 0.6B on a phone, MiniCPM5 2B on a
 * desktop — and reads the probability of each option's tokens directly. That is
 * far better than string matching for "which of these did they mean", and it
 * keeps working with no network, so it belongs BELOW the network tiers.
 *
 * But its own documentation is explicit: those scores are a softmax over only
 * the displayed option tokens, and are NOT calibrated confidence. It also
 * measures well short of the hosted model on TypeSafe's own benchmarks. So this
 * tier is wired `calibrated: false`, which means a fill from it is always
 * provisional and can never silence-commit at 'other-person' or above. It gets
 * the stage painted; the user or a calibrated tier confirms it.
 */

import type { ActDef, Candidate, Ctx, Filled } from '@intermenu/aiuic-core';
import type { ActScore, OptionsFor, Resolver, SlotCandidates } from './types.js';

export type OptionScorer = (input: {
  state: unknown;
  question: string;
  options: string[];
}) => Promise<number[]>;

export type OnDeviceConfig = {
  /** Returns one probability per option, in the order given. */
  scorer: OptionScorer;
  name?: string;
};

export class OnDeviceResolver implements Resolver {
  readonly name: string;
  readonly local = true;
  readonly calibrated = false;

  constructor(private readonly config: OnDeviceConfig) {
    this.name = config.name ?? 'ondevice';
  }

  async score(text: string, acts: ActDef[], ctx: Ctx, _o: OptionsFor): Promise<ActScore[]> {
    if (acts.length === 0) return [];
    const labels = acts.map((a) => a.name.replace(/_/g, ' '));
    const probs = await this.config.scorer({
      state: { utterance: text, now: ctx.now.toISOString() },
      question: 'Which action is the user asking for?',
      options: labels,
    });
    return acts
      .map((a, i) => ({
        act: a.name,
        score: probs[i] ?? 0,
        phraseMatch: 0,
        requiredCoverage: 0,
      }))
      .sort((x, y) => y.score - x.score);
  }

  async fill(
    text: string,
    act: ActDef,
    filled: Filled,
    ctx: Ctx,
    optionsFor: OptionsFor,
  ): Promise<SlotCandidates> {
    const out: SlotCandidates = {};
    for (const [name, def] of Object.entries(act.slots)) {
      if (name in filled) continue;
      if (def.fill === 'model') continue;
      if (def.primitive === 'quantity' || def.primitive === 'when') continue;

      const options = optionsFor(act, name);
      if (options.length === 0) continue;

      const probs = await this.config.scorer({
        state: { utterance: text, act: act.name, filled },
        question: `Which "${name}" does the user mean?`,
        options: options.map((o) => o.label),
      });

      const cands: Candidate[] = options
        .map((o, i) => ({
          value: o.value,
          label: o.label,
          score: probs[i] ?? 0,
          calibrated: false,
          source: this.name,
        }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

      if (cands.length > 0) out[name] = cands;
    }
    return out;
  }
}
