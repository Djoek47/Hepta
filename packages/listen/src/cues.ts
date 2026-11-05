/**
 * The surface cues a tier-0 detector can see. Each is a phrase people use when
 * they do the thing; none is proof that they did. The heuristic detector
 * weighs them against the conversation (an open question, an earlier claim),
 * and a model-backed detector replaces them with judgment.
 */
import { BACKCHANNEL } from '@intermenu/hepta/lines';
import { words } from './text.js';

const any = (res: RegExp[], s: string) => res.some((r) => r.test(s));
const lower = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

// ----------------------------------------------------------------- diversions

/** Answering criticism with criticism of the other side's record. */
export const WHATABOUT = [
  /\bwhat about (the |your |when |all |his |her |their )?(record|government|party|time|years|cuts|mess|chaos)\b/,
  /\bunder your (government|party|watch|leadership)\b/,
  /\bwhen you were in (office|power|government|charge)\b/,
  /\byour (party|government|side) (did|was|were|cut|left|caused|presided)\b/,
  /\b(his|her|their|your) party caused\b/,
  /\byou(?:'re| are) (one|the last person) to talk\b/,
  /\bpot calling the kettle\b/,
  /\band yet you\b/,
  /\bwhat did you (ever )?do\b/,
];

/** Going after the person instead of the point. */
export const AD_HOMINEM = [
  /\bfrom (a man|a woman|someone|somebody|a person) who\b/,
  /\bnever (built|run|done|worked|held|had) .{0,40}\b(life|job|business|shed|house)\b/,
  /\bhas never done a day'?s work\b/,
  /\b(liar|clueless|incompetent|hypocrite|hypocritical|dishonest|a joke)\b/,
  /\b(you|he|she|they|the [a-z]+) would say that\b/,
  /\b(his|her|their|your) union\b/,
  /\byou people\b/,
  /\bcoming from (you|him|her|them)\b/,
  /\btypical of (you|him|her|them)\b/,
  /\bshould apologi[sz]e\b/,
  /\ba (chatbot|machine|computer program)\b/,
];

/** Restating a commitment against a weaker test. */
export const GOALPOSTS = [
  /\bwhat matters (is|now is)\b/,
  /\bthe real (measure|test|question|issue|point)\b/,
  /\bwhat (i|we) (meant|mean) (was|is)\b/,
  /\b(i|we) never (said|promised|committed)\b/,
  /\bno longer (rising|growing|falling)\b/,
  /\bit was always about\b/,
  /\bthe important thing is\b/,
];

/** Opening moves of an answer to a question nobody asked. */
export const DEFLECT = [
  /\bwhat i can tell you\b/,
  /\bthe point is\b/,
  /\blet me be (clear|very clear)\b/,
  /\bwhat (people|voters|families) (care|want|need)\b/,
  /\bthe real issue\b/,
  /\blet'?s be honest\b/,
  /\bi'?ll tell you what\b/,
];

/** Someone moving the conversation on, out loud. */
export const TRANSITION = [
  /\blet'?s (turn|move|go|talk|start|look|come) (to|on|about|with|at)\b/,
  /\bturn(ing)? (now )?to\b/,
  /\bmoving on\b/,
  /\bmove on to\b/,
  /\bon (to|a different|another) (subject|topic|note)\b/,
  /\bnext,?\b/,
  /\bwelcome back\b/,
  /\bleave it there\b/,
];

/** A speaker tying what they say to what was just said. */
export const LINK = [
  /^(and|but|so)?\s*(on|about) (that|this|the) (point|question)\b/,
  /^on [a-z ]{3,30},/,
  /\b(going|coming|come) back (to|on)\b/,
  /\bcan i come back on\b/,
  /\bstay with\b/,
  /\bstill on\b/,
  /\bthe question was\b/,
  /^(and )?what about\b/,
];

// ---------------------------------------------------------------- not the talk

const AD = [
  /\bterms and conditions\b/, /\bt ?& ?cs?\b/, /\bbrought to you by\b/, /\bsponsored by\b/, /\bdot com\b/, /\.com\b/,
  /\bvisit [a-z]+\b/, /\bcall now\b/, /\border (now|today)\b/, /\bsave up to\b/, /\b\d+ ?% off\b/, /\bhalf price\b/,
  /\bflash sale\b/, /\bthis weekend only\b/, /\blimited time\b/, /\bmay be repossessed\b/, /\bsubject to status\b/,
  /\brates from\b/, /\bswitch your\b/, /\bavailable (now|in store|online)\b/, /\bthinking of (moving|switching|buying)\b/,
];

export function adScore(text: string): number {
  const s = lower(text);
  return AD.filter((r) => r.test(s)).length;
}

export function isCrowd(text: string): boolean {
  return /^\s*\[(applause|laughter|cheering|cheers|booing|crowd|music|inaudible)\]\s*$/i.test(text);
}

const NOD = new Set([...BACKCHANNEL, 'mm-hmm', 'mmhmm', 'mhmm', 'uh-huh', 'exactly', 'indeed', 'true', 'absolutely', 'yup', 'aha', 'ah', 'hm']);

/** A nod: every word is a "go on". Short, no question, no content. */
export function isNod(text: string): boolean {
  const s = lower(text).replace(/[.,!]/g, ' ');
  if (/\?/.test(text)) return false;
  const ws = s.split(/\s+/).filter(Boolean);
  return ws.length > 0 && ws.length <= 3 && ws.every((w) => NOD.has(w));
}

// ----------------------------------------------------------------- addressing

export function mentionsHepta(text: string): boolean {
  return /\bhepta\b/i.test(text);
}

const QUESTION_START = /^(and |but |so |well |now |then |okay |ok )*(how|what|why|when|where|who|whom|which|whose|is|are|was|were|do|does|did|will|would|can|could|should|shall|have|has|had|may|might|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|can'?t)\b/;

/** A question: a question mark, or the shape of one. */
export function isQuestion(text: string): boolean {
  const s = lower(text).trim();
  if (/\?\s*$/.test(s) || /\?/.test(s)) return true;
  // Strip a leading vocative ("Minister, are you…").
  const body = s.replace(/^[a-z ]{2,30},\s*/, '');
  return QUESTION_START.test(body) && !/\.$/.test(s);
}

/** The question sentences in a text (a turn may hold a statement and a question). */
export function questionSentences(text: string): string[] {
  const parts = text.match(/[^.?!]+[.?!]?/g) ?? [text];
  return parts.map((p) => p.trim()).filter((p) => p && isQuestion(p));
}

export const cues = {
  whatabout: (s: string) => any(WHATABOUT, lower(s)),
  adHominem: (s: string) => any(AD_HOMINEM, lower(s)),
  goalposts: (s: string) => any(GOALPOSTS, lower(s)),
  deflect: (s: string) => any(DEFLECT, lower(s)),
  transition: (s: string) => any(TRANSITION, lower(s)),
  link: (s: string) => any(LINK, lower(s).trim()),
};

export function wordCount(text: string): number {
  return words(text).length;
}
