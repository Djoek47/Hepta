/**
 * What Hepta says, once the timing says it should: a response card on screen,
 * short, citing who said what and when. Written by Claude Sonnet when there is
 * a key, by a local template when there is not (or when Sonnet fails).
 *
 * The writing goes round the ported pyramid. The aggregator reads — the
 * evidence pack and the conversation's own record (points, open questions,
 * contradictions) — and returns findings. The orchestrator is the writer: it
 * gets copies of the findings and returns an answer, and it holds no handle to
 * change anything. The congregator records goal, findings, plan and answer;
 * that ledger goes into the session export, so every response can be traced to
 * what it rested on.
 */
import { createAIUIC, type Ctx } from '@intermenu/aiuic-core';
import { Aggregator, Pyramid, type Finding, type Ledger, type Source } from '@intermenu/aiuic-pyramid';
import { SONNET, textOf, type ClaudeLike } from './claude.js';
import { clock } from './text.js';
import type { EvidenceItem, Mode, Quote, SpeakerInfo } from './types.js';

export type ResponseReason = 'cue' | 'question' | 'contradiction' | 'against-stance' | 'point';

export type ResponseRequest = {
  mode: Mode;
  reason: ResponseReason;
  /** What was said to Hepta, or the sentence that earned the point. */
  said?: Quote;
  /** The cards to raise, newest last. */
  points: { text: string; detail?: string; quotes: Quote[] }[];
  /** The last few utterances, oldest first. */
  recent: Quote[];
  open: { text: string; by: string; to: string | null; askedMs: number; status: string }[];
  /** Figures on record: what stands, and what contradicts it. */
  claims: { speaker: string; subject: string; value?: number; unit?: string; atMs: number; text: string; status: string }[];
  evidence: EvidenceItem[];
  stance?: { position: string; confidence: number; conceded: boolean; overridden: boolean; replies: string[] };
  speakers: SpeakerInfo[];
};

export type ResponseCard = {
  id: string;
  decisionId: string;
  status: 'writing' | 'done' | 'failed';
  text: string;
  responder: string;
  reason: ResponseReason;
  /** Audio time the decision to respond was made. */
  atMs: number;
  /** Wall time from the decision to the first words on screen, and to the whole card. */
  firstMs?: number;
  totalMs?: number;
  cites: Quote[];
  /** The pyramid's record of how it was written. */
  ledger?: Ledger;
  error?: string;
};

export interface Responder {
  readonly name: string;
  write(req: ResponseRequest, findings: readonly Finding[], onText?: (delta: string) => void, signal?: AbortSignal): Promise<string>;
}

// ------------------------------------------------------------------ template

const who = (id: string, speakers: SpeakerInfo[]) => speakers.find((s) => s.id === id)?.name ?? id;

/** The local writer: the cards, read out plainly. No key, no network, no invention. */
export class TemplateResponder implements Responder {
  readonly name = 'template';
  async write(req: ResponseRequest, _findings: readonly Finding[], onText?: (d: string) => void): Promise<string> {
    const text = template(req);
    onText?.(text);
    return text;
  }
}

export function template(req: ResponseRequest): string {
  const pts = req.points.slice(-3);
  // A debater that has conceded says so, whatever it is asked next.
  if (req.mode === 'debater' && req.stance?.conceded && req.reason !== 'contradiction') {
    const last = req.stance.replies[req.stance.replies.length - 1];
    return `Fair point — I accept that${last ? `: “${last}”` : '.'}`;
  }
  if (req.reason === 'against-stance' && req.stance) {
    return req.stance.conceded
      ? `Fair point — I take that back. ${req.stance.replies.slice(-1)[0] ? `“${req.stance.replies.slice(-1)[0]}”` : ''}`.trim()
      : `${req.stance.position}${pts[0]?.detail ? ` ${pts[0].detail}` : ''}`;
  }
  if (req.reason === 'contradiction' && pts.length) return `${pts[pts.length - 1]!.text} Which one stands?`;
  if (req.mode === 'conversation' && req.reason === 'question') {
    // No model to reason with: read back the person's own figures, with times, and any that changed.
    const mine = req.claims.filter((c) => c.speaker === req.said?.speaker && c.value !== undefined && c.status !== 'superseded').slice(-4);
    if (mine.length === 0) return `I heard: “${req.said?.text ?? ''}” — I have no figures from you to check it against yet.`;
    const fig = (c: (typeof mine)[number]) => `${c.subject} ${c.unit && /[£$€]/.test(c.unit) ? c.unit : ''}${c.value!.toLocaleString('en-GB')}${c.unit === '%' ? '%' : ''} at ${clock(c.atMs)}`;
    const changed = mine.filter((c) => c.status === 'contradicts');
    return `From what you said: ${mine.map(fig).join('; ')}.${changed.length ? ` The ${changed[0]!.subject} changed — which figure stands?` : ''}`;
  }
  if (pts.length === 0) {
    if (req.mode === 'debater' && req.stance) return req.stance.conceded ? 'I accept the point made against me.' : req.stance.position;
    return 'Nothing to flag so far.';
  }
  const lead = pts.length === 1 ? 'One thing.' : `${['', 'One', 'Two', 'Three'][pts.length]} things.`;
  return `${lead} ${pts.map((p) => p.text).join(' ')}`;
}

// -------------------------------------------------------------------- sonnet

export const RESPONDER_SYSTEM = `You are Hepta. You listen to live conversations — one person talking with you, a debate in which you argue a position, or a TV panel you monitor for the operator — and you answer on screen, at the speed of reading. You never speak at length. Your answer appears as a card while people are still talking.

How you answer:
- One to three short sentences, sixty words at most. No greeting, no preamble, no sign-off, no lists, no markdown.
- Cite who said what and when, with their exact words: S2 at 04:10: “3 percent”. Use the speaker ids and times you are given; a name may follow the id in brackets the first time.
- Report; do not accuse. "S1 moved from housing to crime; S2's question is still open" — never "S1 dodged" or "S1 lied". Let the quotes carry the weight.
- Use only what is in the findings, the evidence pack and the transcript you are given. Never invent a figure, a source, a date or a quote. If something cannot be checked from what you have, say so in a few words.
- Numbers exactly as said, with their units.

By mode:
- conversation: the person is talking to you. Answer their question from what they have told you, using their own figures and times. If they gave two different figures for the same thing, say which two and ask which stands.
- debater: you argue the stance you are given, with its evidence. When you are cutting in because the other side contradicted your evidence, give the evidence and its source in one sentence. If your stance has been conceded (conceded: true), say plainly that the point against you stands; do not argue on. If it is still held after a reason against it, answer the reason once.
- panel: you speak when the moderator cues you or someone puts a question to you. Give the most important flags first: questions not answered (who asked, when, the exact question), changes of subject away from an open question, contradictions of earlier figures or of the evidence pack. If there is nothing to flag, say so in one sentence.

The input is one JSON object: mode, reason (why you are speaking now), said (the sentence that prompted you), findings (what the record holds: each with its source and claim), recent (the last utterances: speaker, time, text), open (questions not yet answered), claims (figures on record, with who said them and when), evidence, stance, speakers. Write only the card's text.

Examples of good cards:
- panel, cued, two flags: S2 (Minister) moved from housing to crime at 00:21; “How is it funded?” — S3 at 00:13 — is still not answered. S3 at 00:43 turned to the minister rather than the point.
- panel, cued, a changed figure: S2 at 00:06: “growth this year is 3 percent”; at 00:52: “growth is running at 5 percent”. The evidence pack has 1.2% (ONS, Q3 2026).
- conversation, asked "does that add up?": You said your savings goal was 300 a month at 00:05 and 500 at 00:20; rent 1,450 and groceries about 400. Which savings figure should I use?
- debater, cutting in on evidence: The independent estimate is under 1% of GDP a year (climate committee, 2025), not 5%.
- debater, after conceding: Fair point on the grid upgrades — that cost is not in the estimate I cited.
- panel, cued, nothing to flag: Nothing to flag so far: both questions put tonight were answered.

What not to write: opinions about who is winning; advice nobody asked for; anything you would have to guess.`;

export type SonnetOptions = { client: ClaudeLike; model?: string; maxTokens?: number };

export class SonnetResponder implements Responder {
  readonly name = 'sonnet';
  constructor(private readonly o: SonnetOptions) {}

  async write(req: ResponseRequest, findings: readonly Finding[], onText?: (d: string) => void, signal?: AbortSignal): Promise<string> {
    const api = this.o.client.beta?.messages ?? this.o.client.messages;
    const body = {
      mode: req.mode, reason: req.reason,
      said: req.said ? `${req.said.speaker} at ${clock(req.said.atMs)}: “${req.said.text}”` : null,
      findings: findings.filter((f) => f.confidence > 0).map((f) => ({ source: f.source, claim: f.claim })),
      recent: req.recent.map((q) => [q.speaker, clock(q.atMs), q.text]),
      open: req.open.map((q) => ({ asked: `${q.by} at ${clock(q.askedMs)}`, to: q.to, text: q.text, status: q.status })),
      claims: req.claims.map((c) => `${c.speaker} at ${clock(c.atMs)}: “${c.text}”${c.status === 'contradicts' ? ' (contradicts an earlier figure)' : c.status === 'superseded' ? ' (since revised)' : ''}`),
      evidence: req.evidence.map((e) => `${e.text}${e.source ? ` (${e.source})` : ''}`),
      ...(req.stance ? { stance: req.stance } : {}),
      speakers: req.speakers.filter((s) => !s.outside).map((s) => `${s.id}${s.name ? ` (${s.name}${s.role ? ', ' + s.role : ''})` : ''}`),
    };
    const stream = api.stream({
      model: this.o.model ?? SONNET,
      max_tokens: this.o.maxTokens ?? 400,
      // Thinking off on Sonnet 5.5 is `between_tools`; low effort. This is a short card, not a proof.
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
      // On a policy decline, the API retries on a fallback model inside the same call.
      ...(this.o.client.beta ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      system: [{ type: 'text', text: RESPONDER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(body) }],
    }, signal ? { signal } : {});
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) onText?.(ev.delta.text);
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('sonnet: declined');
    return textOf(msg).trim();
  }
}

// ------------------------------------------------------------------- pyramid

/** The conversation's own record as findings: points raised, questions open, the evidence pack. */
function recordSources(req: ResponseRequest): Source[] {
  const points: Source = {
    name: 'record', local: true,
    read: () => [
      ...req.points.map((p) => ({ source: 'record', claim: p.detail ? `${p.text} ${p.detail}` : p.text, confidence: 1, calibrated: true })),
      ...req.open.filter((q) => q.status !== 'answered').map((q) => ({
        source: 'record/question', claim: `“${q.text}” asked by ${q.by} at ${clock(q.askedMs)}${q.to ? ` to ${q.to}` : ''}: ${q.status === 'dodged' ? 'not answered' : 'open'}`, confidence: 1, calibrated: true,
      })),
    ],
  };
  const evidence: Source = {
    name: 'evidence', local: true,
    read: () => req.evidence.map((e) => ({ source: 'evidence', claim: `${e.text}${e.source ? ` (${e.source})` : ''}`, ...(e.value !== undefined ? { value: e.value } : {}), confidence: 1, calibrated: true })),
  };
  return [points, evidence];
}

const ATTENTION = { foreground: true, unlocked: true, proximityClear: true, listening: true };

/**
 * Write a response round the pyramid: aggregate (read), orchestrate (the
 * writer, with copies), congregate (the record). Falls back to the template if
 * the writer fails, and says so in the ledger.
 */
export async function writeResponse(
  req: ResponseRequest, writer: Responder, onText?: (d: string) => void, signal?: AbortSignal,
): Promise<{ text: string; responder: string; ledger: Ledger; error?: string }> {
  const ctx = (): Ctx => ({ now: new Date(), actor: { id: 'hepta' }, attention: ATTENTION });
  const ui = createAIUIC({ ctx });
  let used = writer.name;
  let error: string | undefined;
  const pyramid = new Pyramid({
    app: { ui, reset() {}, draw() {} },
    aggregator: new Aggregator(recordSources(req)),
    ctx,
    maxLooks: 0,
    orchestrator: async (input) => {
      try {
        return { kind: 'answer', answer: await writer.write(req, input.findings, onText, signal) };
      } catch (e) {
        error = String((e as Error)?.message ?? e);
        used = `template (after ${writer.name} failed)`;
        const text = template(req);
        onText?.(text);
        return { kind: 'answer', answer: text };
      }
    },
  });
  const goal = req.said ? `respond (${req.reason}) to ${req.said.speaker}: ${req.said.text}` : `respond (${req.reason})`;
  const out = await pyramid.pursue(goal);
  const text = out.kind === 'answered' ? out.answer : out.kind === 'split' && out.then.kind === 'answered' ? out.then.answer : template(req);
  return { text, responder: used, ledger: pyramid.congregator.view(), ...(error ? { error } : {}) };
}
