/**
 * Claude Haiku as a Jev transport.
 *
 * It answers the same typed questions a hosted Jev would — a choice from a
 * declared answer space, with a probability and a runner-up — so the detector
 * cannot tell which one it is talking to. Latency is the whole game here:
 *
 *   - the system prompt is fixed and cached (Haiku 5.5 caches from 512 tokens;
 *     this one is longer than that on purpose, and nothing volatile is in it)
 *   - thinking is off and effort is low: this is classification, not reasoning
 *   - the output is constrained to one small JSON schema that never changes,
 *     so it is compiled once and every answer parses
 *   - the response is streamed, so time to first token is measured apart
 *     from time to the whole answer
 */
import type { JevAnswer, JevQuestion, JevRequest, JevResponse, JevTransport } from '@intermenu/aiuic-resolve';
import { HAIKU, textOf, type ClaudeLike } from './claude.js';

export const JEV_SYSTEM = `You are Jev, the decision layer of Hepta. Hepta listens to live conversations — one person talking with Hepta, or a multi-speaker debate such as a TV panel — and on every partial transcript it must know what is happening. You do not converse. You answer typed questions over answer spaces the request declares, each with a probability.

INPUT: one JSON object.
- "state": the conversation so far. "mode" (conversation, debater, panel); "speakers" (S1, S2… with names and roles); "recent" turns as [speaker, mm:ss, text]; "onAir" (the subject being discussed before this utterance); "openQuestions" (put to someone, not yet answered, with turnsSince); "claims" (earlier factual claims with ids); "evidence" (checked facts with ids); "stance" (debater mode: the view Hepta argues); "localGuess" (a fast keyword detector's guess — often wrong, never binding); and "now": the utterance being heard (speaker, text so far, final or not).
- "questions": what to answer. Each has a key, a type (choice or noul) and, for choice, the allowed options.

OUTPUT: {"answers":[{"key","choice","p","alt","alt_p"}, …]} — one entry per question, in the order given.
- choice: "choice" is exactly one of the declared options. "p" is the probability it is right. "alt" is the next most likely option and "alt_p" its probability; use "" and 0 when there is none.
- noul: "choice" is "yes" or "no"; "p" is the probability of that answer.
- Be calibrated: 0.9 means right nine times in ten. When the evidence is thin, prefer "none" with a modest p.
- When "now.final" is false the sentence is unfinished. Judge what it most likely turns out to be, and give the main alternative in "alt": that is how a half-heard sentence keeps two readings alive.

DEFINITIONS
shift — how the subject moved from onAir to now:
- none: the same subject, including questions about it, answers to it, and disagreement over it.
- follow_up: a move to a connected subject, invited by what was just said, or a return to an earlier open line of thought ("coming back to the funding").
- natural: a cooperative move to a new subject, usually by the moderator, or once a question has been answered ("let's turn to immigration").
- diversion: the speaker moves away from an open question or the point under discussion — answering a different question, pointing at the other side's record, or turning on the person.
diversion — which kind, or none:
- deflection: a question was put to this speaker and this answers a different one (asked how homes are funded, talks about crime).
- whataboutism: meets criticism by pointing at the other side's record ("under your government…", "what about when you…").
- ad_hominem: attacks the person, their motives or competence instead of the argument ("a man who has never built a shed", "his union has been on strike").
- moving_goalposts: restates the speaker's own earlier commitment against a weaker or different test ("halve waiting lists by 2027" becomes "what matters is they're no longer rising").
- changed_claim: gives a different figure or fact than the same speaker gave earlier on the same subject (3% earlier, 5% now).
Not diversions: a fair follow-up question that opens "what about"; disagreeing with someone else's figure; an answer that opens "what I can tell you is" and then answers; a moderator moving the programme on.
addressed — is now addressed to Hepta: by name, as the moderator's cue for Hepta to speak, or (conversation mode) any question from the person talking with Hepta?
ignore — conversation (part of the debate); ad (an advert or sponsor message); crowd (applause, laughter, cheering); backchannel (a listener's "yeah", "mm", "right" that does not take the turn — but a one-word answer to a question put to that speaker is conversation).
answers — the id of the open question that now answers, or none. Evasion, a restated commitment and a change of subject are none.
contradicts — the id of an earlier claim by the same speaker, or an evidence item, that now contradicts, or none. A revision within about 15% is not a contradiction; another speaker's claim never counts.
topic — the subject of now, from the options given.

Output the JSON object only.`;

/** Fixed, so it compiles once. Short keys: every output token is latency. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          choice: { type: 'string' },
          p: { type: 'number' },
          alt: { type: 'string' },
          alt_p: { type: 'number' },
        },
        required: ['key', 'choice', 'p', 'alt', 'alt_p'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
} as const;

export type HaikuTiming = {
  ttftMs: number;
  totalMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type HaikuTransportOptions = {
  client: ClaudeLike;
  model?: string;
  maxTokens?: number;
  /** Called once per answered request. */
  onTiming?: (t: HaikuTiming) => void;
  now?: () => number;
};

type Raw = { key: string; choice: string; p: number; alt: string; alt_p: number };

/** What goes over the wire: the questions without their long criteria, which live in the cached system prompt. */
function wireQuestions(qs: JevQuestion[]): unknown[] {
  return qs.map((q) => q.type === 'choice'
    ? { key: q.key, type: 'choice', options: Object.keys(q.criteria), ...(Object.entries(q.criteria).some(([k, v]) => k !== v) ? { meaning: q.criteria } : {}) }
    : { key: q.key, type: q.type, question: q.question });
}

export function toAnswers(raw: Raw[], qs: JevQuestion[]): JevAnswer[] {
  const byKey = new Map(qs.map((q) => [q.key, q]));
  const out: JevAnswer[] = [];
  for (const r of raw) {
    const q = byKey.get(r.key);
    if (!q) continue;
    const p = clamp01(r.p);
    if (q.type === 'noul') {
      const yes = r.choice.toLowerCase() === 'yes';
      out.push({ key: r.key, noul: yes ? p : 1 - p, confidence: p });
      continue;
    }
    if (q.type !== 'choice' || !(r.choice in q.criteria)) continue; // an option nobody declared is no answer
    const probabilities: Record<string, number> = { [r.choice]: p };
    if (r.alt && r.alt in q.criteria && r.alt !== r.choice) probabilities[r.alt] = clamp01(r.alt_p);
    out.push({ key: r.key, choice: r.choice, probabilities, confidence: p });
  }
  return out;
}

export function haikuTransport(opts: HaikuTransportOptions): JevTransport {
  const now = opts.now ?? (() => performance.now());
  return async (req: JevRequest, signal?: { readonly aborted: boolean }): Promise<JevResponse> => {
    const t0 = now();
    const user = JSON.stringify({ state: req.state, questions: wireQuestions(req.questions) });
    const stream = opts.client.messages.stream({
      model: opts.model ?? HAIKU,
      max_tokens: opts.maxTokens ?? 400,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
      system: [{ type: 'text', text: JEV_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }, signal instanceof AbortSignal ? { signal } : {});
    let ttft = -1;
    for await (const ev of stream) {
      if (ttft < 0 && ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') ttft = now() - t0;
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('jev: refused');
    if (msg.stop_reason === 'max_tokens') throw new Error('jev: answer cut off at max_tokens');
    const parsed = JSON.parse(textOf(msg)) as { answers?: Raw[] };
    const u = msg.usage ?? {};
    opts.onTiming?.({
      ttftMs: ttft < 0 ? now() - t0 : ttft, totalMs: now() - t0,
      ...(u.input_tokens !== undefined ? { inputTokens: u.input_tokens } : {}),
      ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
      ...(u.cache_read_input_tokens != null ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens != null ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
    });
    return { answers: toAnswers(parsed.answers ?? [], req.questions) };
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
