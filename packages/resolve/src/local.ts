/**
 * Tier 0: the local matcher. Offline, synchronous, no model.
 *
 * This is what makes "the app still works when the model is slow, wrong or
 * absent" a mechanism rather than a hope.
 */

import { defers, mood, refuses, stopping } from './mood.js';
import { normalize } from './text.js';
import type { ActDef, Candidate, Ctx, Filled, Option } from '@intermenu/aiuic-core';
import { matchPhrase, tokenize, type Token } from './text.js';
import {
  DEFAULT_ROUTING,
  type ActScore,
  type OptionsFor,
  type Resolver,
  type RoutingConfig,
  type SlotCandidates,
} from './types.js';

function candidatesForOptions(tokens: Token[], options: Option[]): Candidate[] {
  const out: Candidate[] = [];
  for (const opt of options) {
    const needles = [opt.label, ...(opt.aliases ?? [])];
    let best: { score: number; span: [number, number] } | null = null;
    for (const n of needles) {
      const m = matchPhrase(tokens, n);
      if (m && (!best || m.score > best.score)) best = m;
    }
    if (best && best.score > 0) out.push({ value: opt.value, label: opt.label, ...best });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * §6. Two slots can claim the same words ("Maya's room"). The longer span wins;
 * the loser drops that candidate rather than both filling from one phrase.
 */
export function arbitrateSpans(slots: SlotCandidates): SlotCandidates {
  type Claim = { slot: string; index: number; span: [number, number]; score: number };
  const claims: Claim[] = [];
  for (const [slot, cands] of Object.entries(slots)) {
    cands.forEach((c, index) => {
      if (c.span) claims.push({ slot, index, span: c.span, score: c.score });
    });
  }

  const dropped = new Set<string>();
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.slot === b.slot) continue;
      const overlap = a.span[0] < b.span[1] && b.span[0] < a.span[1];
      if (!overlap) continue;
      const aLen = a.span[1] - a.span[0];
      const bLen = b.span[1] - b.span[0];
      const loser = aLen !== bLen ? (aLen < bLen ? a : b) : a.score < b.score ? a : b;
      dropped.add(`${loser.slot}:${loser.index}`);
    }
  }

  const out: SlotCandidates = {};
  for (const [slot, cands] of Object.entries(slots)) {
    const kept = cands.filter((_, index) => !dropped.has(`${slot}:${index}`));
    if (kept.length > 0) out[slot] = kept;
  }
  return out;
}

export class LocalResolver implements Resolver {
  readonly name = 'local';
  readonly local = true;
  /** An exact string match is right by construction, so its 1.0 means 1.0. */
  readonly calibrated = true;

  constructor(private readonly routing: RoutingConfig = DEFAULT_ROUTING) {}

  async score(text: string, acts: ActDef[], ctx: Ctx, optionsFor: OptionsFor): Promise<ActScore[]> {
    return this.scoreSync(text, acts, ctx, optionsFor);
  }

  async fill(
    text: string,
    act: ActDef,
    filled: Filled,
    ctx: Ctx,
    optionsFor: OptionsFor,
  ): Promise<SlotCandidates> {
    return this.fillSync(text, act, filled, ctx, optionsFor);
  }

  /** Synchronous by design: tier 0 must settle before anything is painted. */
  scoreSync(text: string, acts: ActDef[], ctx: Ctx, optionsFor: OptionsFor): ActScore[] {
    const tokens = tokenize(text);
    const scores: ActScore[] = [];
    const sentenceMood = mood(text);

    for (const act of acts) {
      let phraseMatch = 0;
      for (const p of act.phrases ?? []) {
        const m = matchPhrase(tokens, p);
        if (m && m.score > phraseMatch) phraseMatch = m.score;
      }

      // Coverage counts only the required slots THIS tier can evaluate. A
      // quantity or a date has no option list, so the option matcher can say
      // nothing about it either way; counting it as a miss would depress every
      // act that mentions a number, which is nearly all of them.
      // Free text is left out too: the rest of a sentence always matches
      // something, so it is never evidence of which act was meant. Counting
      // it as coverage made every act whose only slot is free text lose to
      // its own trigger phrase.
      // A slot with a default is not missing when nobody mentions it — it is
      // already answered. Counting it as uncovered sank "what did I miss?",
      // whose only slot is a briefing length that defaults to standard.
      const evaluable = Object.entries(act.slots).filter(
        ([name, s]) => s.required && !s.default && s.primitive !== 'ghostField' && (s.resolve || optionsFor(act, name).length > 0),
      );
      let covered = 0;
      for (const [name, s] of evaluable) {
        const cands = s.resolve
          ? s.resolve(text, ctx, {})
          : candidatesForOptions(tokens, optionsFor(act, name));
        if ((cands[0]?.score ?? 0) < this.routing.tauFill) continue;

        // A matched slot is evidence for THIS act only as far as it is not
        // evidence for every other one. "laundry" belongs to the chore act;
        // "Maya" is a person both acts have a slot for, and on its own it
        // means nothing about which act was meant. Without this, the two
        // score identically and the router has to guess.
        covered += this.discrimination(act, name, text, acts, ctx, optionsFor, tokens);
      }

      const requiredCoverage = evaluable.length ? covered / evaluable.length : 0;

      // Score over the signals that actually spoke, not over every signal that
      // could have. A trigger phrase nobody used is absence of evidence, the
      // same as a slot this tier cannot evaluate — and dividing by a weight
      // nothing filled is what buried "do the laundry" at 0.30.
      let weight = 0;
      let total = 0;
      if (phraseMatch >= this.routing.phraseFloor) {
        weight += this.routing.phraseWeight;
        total += this.routing.phraseWeight * phraseMatch;
      }
      weight += this.routing.coverageWeight;
      total += this.routing.coverageWeight * (evaluable.length > 0 ? requiredCoverage : this.routing.uncheckableCoverage);

      // Nothing named the act, and the sentence is not asking for anything:
      // a chore or a name mentioned in passing is not a request. Scaled so that
      // even full coverage lands under the routing threshold. Halving was the
      // first try, and "did Sam do the laundry" (both slots filled, score 1.0)
      // halved to exactly the threshold, opened a card, and held it to commit.
      // A sentence that asks for nothing scores nothing. Not "less": a chore
      // named in a question or a remark is not a weak request, it is not a
      // request. Two rounds of review found the softer versions:
      //   halving   "did Sam do the laundry" landed exactly on the threshold,
      //             opened a card and held it to commit;
      //   a floor   the score still cleared Hepta's own lower floor (0.25), so
      //             the act led the stage and reached HOLD anyway.
      // A trigger phrase does not override this: "who did the dishes for Sam?"
      // matched "for". The person can always say the same thing as a request.
      //
      // One opening, and only one. A question may ASK for something that
      // changes nothing — "what did I miss?" is how people ask for a
      // briefing — so a question opens a card when both hold: the act costs
      // nothing ('self', declared, not narrowed at runtime), and the words
      // matched a phrase of two words or more. A single common word like
      // "for" never turns a question into a request, and nothing that touches
      // somebody else is ever started by a question.
      const declared = typeof act.radius === 'string' ? act.radius : act.radius.max;
      let askedFor = 0;
      if (sentenceMood === 'question' && declared === 'self') {
        for (const p of act.phrases ?? []) {
          if (p.trim().split(/\s+/).length < 2) continue;
          const m = matchPhrase(tokens, p);
          if (m && m.score > askedFor) askedFor = m.score;
        }
      }
      // Refusing, putting off and cancelling are not asking for this act.
      //   "don't brief me"            refuses: starts nothing
      //   "update me later"           defers: starts nothing now, unless the act
      //                               has a time slot to hold the "later"
      //   "cancel the briefing"       stops: only an act that owns the verb
      //                               ("cancel", "skip") may take the sentence
      // Words that are part of the act's own name do not count against it:
      // "do not disturb" names the quiet-hours setting, it does not refuse it.
      const own = (act.phrases ?? []).map((p) => normalize(p)).filter(Boolean)
        .sort((a, b) => b.length - a.length);
      let rest = ` ${normalize(text.replace(/[\u2019'-]/g, ' '))} `;
      for (const p of own) rest = rest.split(` ${p} `).join(' ');
      const hasTime = Object.values(act.slots).some((sd) => sd.primitive === 'when');
      const verb = stopping(rest);
      const declined = refuses(rest) || (defers(rest) && !hasTime) || !!verb;
      const asking = !declined && (sentenceMood === 'request' || askedFor >= this.routing.phraseFloor);
      scores.push({
        act: act.name,
        phraseMatch,
        requiredCoverage,
        score: asking && weight > 0 ? total / weight : 0,
      });
    }

    return scores.sort((a, b) => b.score - a.score);
  }

  /**
   * 1 when only this act could have matched those words, falling toward 0 as
   * more acts could have matched them just as well.
   */
  private discrimination(
    act: ActDef,
    slot: string,
    text: string,
    acts: ActDef[],
    ctx: Ctx,
    optionsFor: OptionsFor,
    tokens: Token[],
  ): number {
    let rivals = 0;
    for (const other of acts) {
      if (other.name === act.name) continue;
      for (const [name, sd] of Object.entries(other.slots)) {
        if (!sd.required || sd.primitive === 'ghostField') continue;
        const cands = sd.resolve
          ? sd.resolve(text, ctx, {})
          : candidatesForOptions(tokens, optionsFor(other, name));
        if ((cands[0]?.score ?? 0) >= this.routing.tauFill) { rivals++; break; }
      }
    }
    return 1 / (1 + rivals);
  }

  fillSync(
    text: string,
    act: ActDef,
    filled: Filled,
    ctx: Ctx,
    optionsFor: OptionsFor,
  ): SlotCandidates {
    const tokens = tokenize(text);
    const out: SlotCandidates = {};

    for (const [name, def] of Object.entries(act.slots)) {
      if (name in filled) continue;
      if (def.fill === 'model') continue; // a local matcher cannot write free text

      if (def.resolve) {
        const c = def.resolve(text, ctx, filled);
        if (c.length > 0) out[name] = [...c].sort((a, b) => b.score - a.score);
        continue;
      }

      const cands = candidatesForOptions(tokens, optionsFor(act, name));
      if (cands.length > 0) out[name] = cands;
    }

    return arbitrateSpans(out);
  }
}
