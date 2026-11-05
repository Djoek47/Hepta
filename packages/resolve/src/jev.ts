/**
 * Tier 1: Jev (TypeSafe AI System One).
 *
 * Jev answers typed questions over an answer space YOU declare, and returns a
 * probability distribution plus a confidence. That is the same shape AIUIC
 * already needs for a slot, so its output maps onto `Candidate[]` with no
 * change to the core.
 *
 * What it is good for here:
 *   - act routing            — "which act is this?" is a Choice over act names
 *   - bounded slots          — face, chip, objectCard: a Choice over options
 *   - policy questions       — Noul: "is this urgent?", "is this a reply?"
 *
 * What it cannot do, so do not route it here:
 *   - extract a quantity, a date or a name that is not already an option
 *     (Score is an ordinal level, not a number read out of the sentence)
 *   - write free text: a ghostField slot is an LLM's job
 *
 * IMPORTANT: Jev is a hosted, closed model. Every call is a network call, so it
 * is tier 1 and never tier 0. Nothing in the degraded path may depend on it.
 */

import type { ActDef, Candidate, Ctx, Filled, Option } from '@intermenu/aiuic-core';
import type { ActScore, OptionsFor, Resolver, SlotCandidates } from './types.js';

// ------------------------------------------------------------------- wire

export type JevChoiceQuestion = {
  type: 'choice';
  key: string;
  question: string;
  /** option key → a short description of what that option means. */
  criteria: Record<string, string>;
};

export type JevScoreQuestion = {
  type: 'score';
  key: string;
  question: string;
  /** Ordered levels, lowest first. */
  criteria: string[];
};

export type JevNoulQuestion = {
  type: 'noul';
  key: string;
  question: string;
  criteria?: string;
};

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export type JevRequest = {
  model: string;
  /** Structured program state, not a chat transcript. */
  state: unknown;
  questions: JevQuestion[];
};

export type JevAnswer = {
  key: string;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number> | number[];
  confidence?: number;
};

export type JevResponse = { answers: JevAnswer[] };

/**
 * Injectable so the mapping is testable without a key, and so the one place
 * that knows the HTTP shape is a single function.
 *
 * The public docs describe the primitives and their returns but not the batch
 * request envelope, so treat `JevRequest`/`JevResponse` as the adapter seam:
 * verify against the SDK before the first live call.
 */
// Declared locally: the core and its siblings compile without DOM or Node libs.
type Abortable = { readonly aborted: boolean };

export type JevTransport = (req: JevRequest, signal?: Abortable) => Promise<JevResponse>;

// ---------------------------------------------------------------- mapping

/** A stable, wire-safe key for an option, plus a way back to its value. */
export function optionKey(opt: Option, index: number): string {
  const slug = opt.label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || `opt_${index}`;
}

export function slotQuestion(
  act: ActDef,
  slot: string,
  options: Option[],
): { question: JevChoiceQuestion; back: Map<string, unknown> } | null {
  if (options.length === 0) return null;
  const criteria: Record<string, string> = {};
  const back = new Map<string, unknown>();
  options.forEach((o, i) => {
    const k = optionKey(o, i);
    criteria[k] = o.label;
    back.set(k, o.value);
  });
  return {
    question: {
      type: 'choice',
      key: `${act.name}.${slot}`,
      question: `Which "${slot}" does the user mean?`,
      criteria,
    },
    back,
  };
}

/** Routing is itself a Choice, which is why one call can price every act at once. */
export function routingQuestion(acts: ActDef[]): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const a of acts) {
    criteria[a.name] = a.phrases?.length
      ? `the user wants to ${a.name.replace(/_/g, ' ')} (e.g. ${a.phrases.join(', ')})`
      : `the user wants to ${a.name.replace(/_/g, ' ')}`;
  }
  return {
    type: 'choice',
    key: '__route__',
    question: 'Which action is the user asking for?',
    criteria,
  };
}

function distribution(a: JevAnswer): Record<string, number> {
  if (a.probabilities && !Array.isArray(a.probabilities)) return a.probabilities;
  if (a.choice) return { [a.choice]: a.confidence ?? 1 };
  return {};
}

// --------------------------------------------------------------- resolver

export type JevConfig = {
  transport: JevTransport;
  model?: string;
  /** Beyond this, treat the call as absent and stay with the local result. */
  timeoutMs?: number;
};

export class JevResolver implements Resolver {
  readonly name = 'jev';
  /** Hosted only. There is no on-device Jev. */
  readonly local = false;
  /** Calibration is the product claim. Verify it on your own acts before trusting it. */
  readonly calibrated = true;

  constructor(private readonly config: JevConfig) {}

  private async ask(state: unknown, questions: JevQuestion[]): Promise<JevResponse> {
    return this.config.transport({
      model: this.config.model ?? 'jev-latest',
      state,
      questions,
    });
  }

  async score(
    text: string,
    acts: ActDef[],
    ctx: Ctx,
    _optionsFor: OptionsFor,
  ): Promise<ActScore[]> {
    if (acts.length === 0) return [];
    const res = await this.ask({ utterance: text, now: ctx.now.toISOString() }, [
      routingQuestion(acts),
    ]);
    const answer = res.answers.find((a) => a.key === '__route__');
    const dist = answer ? distribution(answer) : {};
    return acts
      .map((a) => ({
        act: a.name,
        score: dist[a.name] ?? 0,
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
    const questions: JevQuestion[] = [];
    const backs = new Map<string, Map<string, unknown>>();

    for (const [name, def] of Object.entries(act.slots)) {
      if (name in filled) continue;
      if (def.fill === 'model') continue; // free text is an LLM's job
      // Jev chooses among declared options; it does not read a number or a
      // date out of a sentence. Those stay with the local grammar.
      if (def.primitive === 'quantity' || def.primitive === 'when') continue;

      const built = slotQuestion(act, name, optionsFor(act, name));
      if (!built) continue;
      questions.push(built.question);
      backs.set(built.question.key, built.back);
    }

    if (questions.length === 0) return {};

    // One call prices every remaining slot at once: Jev samples in parallel.
    const res = await this.ask(
      { utterance: text, act: act.name, filled, now: ctx.now.toISOString() },
      questions,
    );

    const out: SlotCandidates = {};
    for (const answer of res.answers) {
      const back = backs.get(answer.key);
      if (!back) continue;
      const slot = answer.key.slice(act.name.length + 1);
      const dist = distribution(answer);
      const cands: Candidate[] = Object.entries(dist)
        .filter(([k]) => back.has(k))
        .map(([k, p]) => ({ value: back.get(k), score: p }))
        .sort((a, b) => b.score - a.score);
      if (cands.length > 0) out[slot] = cands;
    }
    return out;
  }
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: Abortable },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

declare const fetch: FetchLike;

/** Default HTTP transport. Verify the envelope against the SDK before use. */
export function httpTransport(opts: {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
}): JevTransport {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? 'https://api.typesafe.ai';
  return async (req, signal) => {
    const res = await f(`${base}/v1/systemone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(req),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`jev: ${res.status} ${await res.text()}`);
    return (await res.json()) as JevResponse;
  };
}
