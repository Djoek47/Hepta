/**
 * Insight cards: what the operator sees the instant something happens.
 *
 * The voice is the brand's: it reports, it does not accuse. Who said what and
 * when, in their exact words — "S1 moved from housing to crime. S2's question
 * is still open." — never "S1 dodged the question!". A card made on half a
 * sentence says so (provisional) and is confirmed or retracted when the
 * sentence ends.
 */
import { clock } from './text.js';
import type { ClaimView, DiversionType, EvidenceItem, JevDecision, QuestionView, Quote } from './types.js';

export type InsightKind = 'shift' | 'diversion' | 'dodged' | 'contradiction' | 'evidence' | 'correction' | 'repeat' | 'addressed';
export type InsightStatus = 'provisional' | 'confirmed' | 'retracted';

export type Insight = {
  id: string;
  kind: InsightKind;
  status: InsightStatus;
  /** Who it is about. */
  speaker: string;
  atMs: number;
  /** One sentence for the card. */
  text: string;
  /** A second line: the quote it rests on. */
  detail?: string;
  quotes: Quote[];
  decisionId: string;
  utteranceId: string;
  type?: DiversionType;
  questionId?: string;
  claimId?: string;
  evidenceId?: string;
  /** When it was first shown, if before the sentence ended. */
  shownAtMs?: number;
};

export const quoteOfQuestion = (q: QuestionView): Quote => ({ speaker: q.by, text: q.text, atMs: q.askedMs, utteranceId: q.utteranceId });
export const quoteOfClaim = (c: ClaimView): Quote => ({ speaker: c.speaker, text: c.text, atMs: c.atMs, utteranceId: c.utteranceId });
export const quoteOf = (d: JevDecision): Quote => ({ speaker: d.speaker, text: d.text, atMs: d.atMs, utteranceId: d.utteranceId });

const figure = (c: { value?: number; unit?: string }) =>
  c.value === undefined ? '' : `${Math.abs(c.value) >= 1e9 ? `${c.value / 1e9} billion` : c.value.toLocaleString('en-GB')}${c.unit === '%' ? '%' : c.unit && /[£$€]/.test(c.unit) ? '' : c.unit ? ' ' + c.unit : ''}`
    .replace(/^(-?)([\d.,]+( billion)?)$/, '$1$2').replace(/^/, c.unit && /[£$€]/.test(c.unit) ? c.unit : '');

const possessive = (s: string) => (s.endsWith('s') ? `${s}’` : `${s}’s`);

/** The card for a diversion, from the decision that found it. */
export function diversionCard(d: JevDecision, from: string | null, q?: QuestionView, claim?: ClaimView): Pick<Insight, 'text' | 'detail'> {
  const t = d.diversion!.type;
  const S = d.speaker;
  const open = q ? ` ${possessive(q.by)} question is still open.` : '';
  const asked = q ? `“${q.text}” asked by ${q.by} at ${clock(q.askedMs)}, not answered.` : undefined;
  switch (t) {
    case 'deflection':
      return from && d.topic && from !== d.topic
        ? { text: `${S} moved from ${from} to ${d.topic}.${open}`, ...(asked ? { detail: asked } : {}) }
        : { text: `${S} answered a different question.${open}`, ...(asked ? { detail: asked } : {}) };
    case 'whataboutism':
      return { text: `${S} answered with ${d.topic?.replace(/’s record$|'s record$/, '') ?? 'the other side'}’s record.${open}`, detail: `“${d.text}” — ${S} at ${clock(d.atMs)}` };
    case 'ad_hominem':
      return { text: `${S} turned to the person${d.topic?.startsWith('about ') ? ` (${d.topic.slice(6)})` : ''}, not the point.${open}`, detail: `“${d.text}” — ${S} at ${clock(d.atMs)}` };
    case 'moving_goalposts':
      return claim
        ? { text: `${S} said “${claim.text}” at ${clock(claim.atMs)}; now “${d.text}”`, detail: 'The test for the same commitment has changed.' }
        : { text: `${S} restated the commitment against a different test.`, detail: `“${d.text}” — ${S} at ${clock(d.atMs)}` };
    case 'changed_claim':
      return claim && d.claim
        ? { text: `${S} said ${figure(claim)} at ${clock(claim.atMs)}, now says ${figure(d.claim)}.`, detail: `“${claim.text}” → “${d.text}”` }
        : { text: `${S} gave a different figure from earlier.`, detail: `“${d.text}”` };
    case 'question_dodged':
      return { text: asked ?? `${S} has not answered.` };
  }
}

export function dodgedCard(q: QuestionView, turns: number): Pick<Insight, 'text' | 'detail'> {
  return { text: `“${q.text}” asked by ${q.by} at ${clock(q.askedMs)}, not answered.`, detail: `${q.to ?? 'Nobody'} has spoken ${turns} times since${q.asks > 1 ? `; asked ${q.asks} times` : ''}.` };
}

export function evidenceCard(d: JevDecision, e: EvidenceItem): Pick<Insight, 'text' | 'detail'> {
  return { text: `${d.speaker} said ${figure(d.claim ?? {}) || `“${d.text}”`}${d.claim?.subject ? ` on ${d.claim.subject}` : ''}; the evidence pack says ${e.text}.`, detail: e.source ? `Source: ${e.source}` : `“${d.text}”` };
}

export function shiftCard(d: JevDecision, from: string, open: QuestionView[]): Pick<Insight, 'text' | 'detail'> | null {
  if (open.length === 0) return null; // a move with nothing left behind is a tag, not a card
  const q = open[open.length - 1]!;
  return { text: `${d.speaker} moved from ${from} to ${d.topic}. The ${from} question is still open.`, detail: `“${q.text}” asked by ${q.by} at ${clock(q.askedMs)}.` };
}
