/**
 * Is this sentence asking for something?
 *
 * A chore or a name in a sentence is not a request: "I love doing the dishes",
 * "did Sam take the bins out", "twenty dollars is a lot". Each of those scored
 * exactly at the routing threshold and opened a card nobody asked for. This is
 * the tier-0 answer: sentence shape, in English and French. It only ever
 * lowers an act that no trigger phrase spoke for, so a sentence that names the
 * act ("can you pay Maya back") is never held back by it.
 */

import { normalize } from './text.js';

export type Mood = 'request' | 'question' | 'statement';

/** Questions that are really requests. */
const POLITE = /^(please|can you|could you|would you|will you|can we|could we|let s|lets|peux tu|pourrais tu|tu peux|pouvez vous|est ce que tu peux|est ce que vous pouvez)\b/;
/** Wanting something is asking for it. */
const WANT = /^(i want|i need|i d like|id like|i would like|we need|we want|je veux|je voudrais|j ai besoin|jai besoin|il faut)\b/;
/** After "can you…": verbs of thinking and telling make it a remark, not a request. */
const REMARK_AFTER_POLITE = /^\s*(believe|imagine|see|tell|guess|remember|understand|feel|think|hear|croire|imaginer|voir|comprendre)\b/;
/** After "I need…" / "je veux…": wanting to say or know something is not asking for an act. */
const REMARK_AFTER_WANT = /^\s*(to\s+)?(tell|say|know|ask|think|remember|let you know|mention|dire|savoir|demander|penser)\b/;
const QUESTION = /^(did|does|is|are|was|were|has|have|had|what|when|where|who|whom|whose|why|how|which|do (you|we|they|i)|est ce|qui|quand|ou est|pourquoi|comment|combien|quel|quelle|quels|quelles)\b/;
const STATEMENT_START = /^(i|we|it|that|this|there|he|she|they|je|j|on|c|ca|il|elle|nous)\b/;
const COPULA = new Set(['is', 'are', 'was', 'were', 'est', 'sont', 'etait']);
/** A word before the copula that makes it a clause's verb, not the sentence's. */
const CLAUSE = new Set(['what', 'who', 'which', 'that', 'whatever', 'whoever', 'ce', 'qui', 'que', 'quoi']);

export function mood(text: string): Mood {
  const t = normalize(text.replace(/[\u2019'-]/g, ' '));
  if (!t) return 'statement';
  // "can you believe…", "I need to tell you…": the opener of a request, the rest of a remark.
  // (Found by the second independent review: both reached HOLD and committed a chore.)
  const polite = POLITE.exec(t), want = WANT.exec(t);
  if (polite && !REMARK_AFTER_POLITE.test(t.slice(polite[0].length))) return 'request';
  if (want && !REMARK_AFTER_WANT.test(t.slice(want[0].length))) return 'request';
  if (polite || want) return 'statement';
  if (text.trim().endsWith('?') || QUESTION.test(t)) return 'question';
  if (STATEMENT_START.test(t)) return 'statement';
  // "twenty dollars is a lot", "Maya is at school": a sentence BUILT on "is" describes.
  // It has to be the main verb: near the front, and not opening a clause of its own
  // ("every morning what is due" is an order, and "is" belongs to "what is due").
  const words = t.split(' ');
  const i = words.findIndex((w) => COPULA.has(w));
  if (i >= 0 && i <= 3 && !CLAUSE.has(words[i - 1] ?? '')) return 'statement';
  return 'request';
}

/**
 * A sentence that refuses. "Don't brief me" names the briefing and asks for
 * the opposite; the third review showed it playing the briefing aloud,
 * because routing matched the act's name and nothing understood "don't".
 * The same hole was older than that: "don't pay Maya" would open the payment
 * card. A refusal starts nothing.
 */
const REFUSE = /(^|\s)(don t|dont|do not|never|not now|no need|no more|please don t)\b|^no\s+\w/;
export function refuses(text: string): boolean {
  const t = normalize(text.replace(/[’'-]/g, ' '));
  return REFUSE.test(t);
}

/**
 * A sentence that puts something off: "update me later", "catch me up after
 * lunch". It starts nothing now — unless the act has a time slot to hold the
 * "later", in which case "remind me tomorrow" is exactly its request.
 */
const DEFER = /\b(later|afterwards|after (lunch|dinner|work|the meeting|this)|tomorrow|tonight|next (week|month|time)|in (a|an|\d+|one|two|five|ten|twenty|thirty) (minute|minutes|hour|hours|day|days)|this (afternoon|evening|weekend)|demain|plus tard|ce soir)\b/;
export function defers(text: string): boolean {
  return DEFER.test(normalize(text.replace(/[’'-]/g, ' ')));
}

/**
 * "Cancel the briefing", "skip the briefing": the word names a different act
 * — the one that cancels — and never the thing being cancelled. Returns the
 * verb, so routing can let an act that owns it ("cancel_meeting") through.
 */
const STOPPING = /\b(cancel|skip|stop|without|forget about|call off)\b/;
export function stopping(text: string): string | null {
  const m = STOPPING.exec(normalize(text.replace(/[’'-]/g, ' ')));
  return m ? m[1]! : null;
}
