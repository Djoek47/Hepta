/**
 * The local backend: tier 0. Word overlap, numbers and surface cues, weighed
 * against what the conversation already holds (open questions, earlier
 * claims, the evidence pack). Microseconds, no network — the baseline every
 * model-backed detector has to beat, and the fallback when one is late.
 */
import { buildLexicon, topicsIn, type Lexicon } from './lexicon.js';
import { adScore, cues, isCrowd, isNod, isQuestion, mentionsHepta, questionSentences } from './cues.js';
import { contentStems, jaccard, keyOverlap, numbers, relDiff, stem, words, endsInOpenNumber } from './text.js';
import type {
  ClaimJudgment, DetectState, Detector, DiversionType, Heard, Judgment, QuestionView, Reading, ShiftType,
} from './types.js';

/** Verbs that sit between a subject and its number and are not the subject. */
const VERBS = new Set(['build', 'builds', 'built', 'bring', 'brings', 'raise', 'raises', 'raised', 'cut', 'cuts', 'rise', 'rises', 'rose',
  'fall', 'falls', 'fell', 'falling', 'gone', 'grow', 'grows', 'growing', 'grew', 'running', 'run', 'runs', 'hit', 'reach', 'reached', 'spend',
  'spent', 'pay', 'paid', 'save', 'teach', 'come', 'came', 'drop', 'dropped', 'went', 'keep', 'kept', 'increase', 'increased', 'decrease',
  'reduce', 'reduced', 'double', 'doubled', 'halve', 'halved', 'stand', 'stands', 'sits', 'take', 'cost', 'costs', 'closing', 'going',
  'expect', 'feel', 'feels', 'leave', 'leaves', 'tried', 'try', 'clearing', 'bringing', 'helping', 'look', 'looked']);

const COMMITMENT = /\b(will|would|going to|plan|plans|promise[ds]?|pledge[ds]?|target|commit(ted|ment)?|aim|by (19|20)\d\d)\b/i;
const REPORTED = /\b(you|he|she|they|the [a-z]+) (said|claimed|told us|promised)\b/i;
const FALLING = /\b(fell|fall|falls|dropped|drop|declined|down|cut|lower|reduced)\s+(by\s+)?(about\s+|around\s+|nearly\s+|almost\s+)?$/;

export type HeuristicOptions = {
  /** Extra subjects and their words, e.g. from tonight's evidence pack. */
  lexicon?: Record<string, string[]>;
};

export class HeuristicDetector implements Detector {
  readonly name: string = 'heuristic';
  readonly local = true;
  private readonly lex: Lexicon;
  private readonly baseLex: Record<string, string[]>;

  constructor(opts: HeuristicOptions = {}) {
    this.baseLex = opts.lexicon ?? {};
    this.lex = buildLexicon(this.baseLex);
  }

  detect(h: Heard, st: DetectState): Judgment {
    const text = h.text.trim();

    // ---- not the conversation
    if (h.event || isCrowd(text)) return ignored('crowd');
    const ad = adScore(text);
    const prev = st.turns[st.turns.length - 1];
    // An ad voice keeps being an ad for the next sentence, but only for a real
    // sentence with nothing of the programme in it: diarizers hand the first
    // words after a break ("Welcome back.") to whoever spoke last.
    const carry = prev?.ignored === 'ad' && prev.speaker === h.speaker && h.startMs - prev.endMs < 4000
      && words(text).length >= 4 && !cues.transition(text) && !mentionsHepta(text);
    if (ad >= 2 || (ad >= 1 && h.final) || carry) return ignored('ad');
    if (isNod(text) && !this.answersPolarNow(text, h, st)) return ignored('backchannel');

    // ---- who it is for
    const conversation = st.mode === 'conversation';
    const addressedToHepta = mentionsHepta(text) || (conversation && isQuestion(text));

    // ---- what it is about
    const { topic, keys } = this.topicOf(text, st);

    // ---- questions and answers
    const question = addressedToHepta ? undefined : this.questionIn(text, h, st);
    const answered = this.answering(text, h, st, topic);

    // ---- claims
    const claims = this.claimsIn(text, h, st, keys);
    const contradiction = claims.find((c) => c.contradicts);

    // ---- diversions
    const div = this.diversion(text, h, st, topic, answered, contradiction);

    // ---- shift
    const shiftType = this.shift(text, h, st, topic, keys, div?.type, addressedToHepta);

    // ---- readings: what this sentence could still turn out to be
    const readings = this.readings(text, h, st, shiftType, div, answered, topic);
    const top = readings[0]!;

    const j: Judgment = {
      topic, topicKeys: keys, shiftType, addressedToHepta, readings,
      confidence: Math.min(0.95, top.p),
    };
    if (div) j.diversion = div;
    const first = contradiction ?? claims[0];
    if (first) j.claim = first;
    if (claims.length > 0) j.claims = claims;
    if (question) j.question = question;
    if (answered) j.answers = answered.id;
    return j;
  }

  // ------------------------------------------------------------------ subject

  topicOf(text: string, st: DetectState): { topic: string | null; keys: string[] } {
    const cur = st.current;
    const named = topicsIn(text, this.stateLexicon(st));
    const stems = contentStems(text);
    // A named subject wins, unless the sentence is mostly about the one on air.
    if (named[0]) {
      if (cur.topic && named[0].topic !== cur.topic && keyOverlap(text, cur.keys) >= 0.5 && named[0].hits < 2) {
        return { topic: cur.topic, keys: cur.keys };
      }
      return { topic: named[0].topic, keys: [...new Set([...named[0].keys, ...stems.slice(0, 4)])] };
    }
    if (cur.topic && (stems.length < 2 || keyOverlap(text, cur.keys) > 0)) return { topic: cur.topic, keys: cur.keys };
    // An existing line of thought this sentence is about.
    const thread = st.threads
      .map((t) => ({ t, o: jaccard(stems, t.keys.map(stem)) }))
      .filter((x) => x.o >= 0.2)
      .sort((a, b) => b.o - a.o)[0];
    if (thread) return { topic: thread.t.topic, keys: thread.t.keys };
    if (stems.length >= 2) {
      const ws = words(text).filter((w) => stems.includes(stem(w)) && !VERBS.has(w));
      const name = ws.slice(0, 2).join(' ') || stems.slice(0, 2).join(' ');
      return { topic: name, keys: stems.slice(0, 6) };
    }
    return { topic: cur.topic, keys: cur.keys };
  }

  private stateLexicon(st: DetectState): Lexicon {
    if (st.evidence.length === 0 && !st.stance) return this.lex;
    const extra: Record<string, string[]> = { ...this.baseLex };
    if (st.stance) extra[st.stance.topic] = [...(extra[st.stance.topic] ?? []), ...st.stance.keys];
    return buildLexicon(extra);
  }

  // ---------------------------------------------------------------- questions

  /** Who a sentence is put to: a name said to them, or else whoever spoke last. */
  addressee(text: string, h: Heard, st: DetectState): string | null {
    const s = text.toLowerCase();
    if (/^(panel|everyone|all of you|both of you)\b/.test(s)) return null;
    const named = st.speakers
      .filter((p) => p.id !== h.speaker && p.name)
      .map((p) => ({ id: p.id, name: p.name!.toLowerCase() }))
      .sort((a, b) => b.name.length - a.name.length);
    for (const p of named) {
      if (new RegExp(`(^|[,.]\\s*|\\s)${escape(p.name)}(,|\\?|\\.|\\s|$)`).test(s)) return p.id;
    }
    // A role said alone ("Minister, …") matches the speaker whose name ends with it.
    const voc = /^([a-z ]{3,30}),/.exec(s)?.[1]?.trim();
    if (voc) {
      const hit = named.find((p) => p.name.endsWith(voc));
      if (hit) return hit.id;
    }
    for (let i = st.turns.length - 1; i >= 0; i--) {
      const t = st.turns[i]!;
      if (t.speaker !== h.speaker && !t.ignored) return t.speaker;
    }
    return null;
  }

  questionIn(text: string, h: Heard, st: DetectState): Judgment['question'] | undefined {
    const qs = questionSentences(text);
    const reask = /\bthe question was\b/i.test(text);
    if (qs.length === 0 && !reask) return undefined;
    const q = qs[qs.length - 1] ?? text;
    const to = this.addressee(text, h, st);
    const keys = [...new Set(contentStems(q))];
    const open = st.questions.filter((x) => x.status === 'open' && x.by !== h.speaker && (to === null || x.to === to));
    const repeat = open
      .map((x) => ({ x, o: Math.max(jaccard(keys, x.keys), keyOverlap(q, x.keys)) }))
      .filter((y) => reask || y.o >= 0.25)
      .sort((a, b) => b.o - a.o || b.x.askedMs - a.x.askedMs)[0];
    return { text: q, to, keys, ...(repeat ? { repeatOf: repeat.x.id } : {}) };
  }

  /** A "Yes." right after a yes-or-no question put to this speaker is an answer, not a nod. */
  private answersPolarNow(text: string, h: Heard, st: DetectState): boolean {
    if (!/^(yes|no|yeah|yep|nope)\b/i.test(text.trim())) return false;
    const last = [...st.questions].reverse().find((q) => q.status === 'open' && q.by !== h.speaker);
    return !!last && (last.to === h.speaker || last.to === null) && h.startMs - last.askedMs < 15_000;
  }

  /** The open question this sentence answers, if any. */
  answering(text: string, h: Heard, st: DetectState, topic: string | null): QuestionView | undefined {
    const open = st.questions.filter((q) => q.status === 'open' && q.by !== h.speaker && (q.to === h.speaker || q.to === null));
    let best: { q: QuestionView; s: number } | undefined;
    for (const q of open) {
      const s = answerScore(text, q, topic);
      if (s >= 0.5 && (!best || s > best.s)) best = { q, s };
    }
    return best?.q;
  }

  // ------------------------------------------------------------------- claims

  claimsIn(text: string, h: Heard, st: DetectState, topicKeys: string[]): ClaimJudgment[] {
    if (!h.final && endsInOpenNumber(text)) return []; // "four…" may still become "four hundred"
    const out: ClaimJudgment[] = [];
    const sentences = text.match(/[^.?!]+[.?!]?/g) ?? [text];
    let prevContent: string[] = [];
    for (const sentence of sentences) {
      const sent = sentence.trim();
      if (!sent) continue;
      const lastSubject = prevContent;
      prevContent = words(sent).filter((w) => contentStems(w).length > 0 && !VERBS.has(w));
      if (isQuestion(sent) || REPORTED.test(sent)) continue;
      for (const clause of sent.split(/,\s+|;\s+|\s+(?:and|but|because|so)\s+/i)) {
        const nums = numbers(clause);
        const n = nums.find((x) => !x.year);
        if (!n) continue;
        const year = nums.find((x) => x.year)?.value;
        const lowerClause = clause.toLowerCase();
        const idx = lowerClause.indexOf(n.raw.toLowerCase().split(' ')[0]!.replace(/[£$€]/, ''));
        const before = words(lowerClause.slice(0, Math.max(0, idx)))
          .filter((w) => contentStems(w).length > 0 && !VERBS.has(w));
        const after = words(lowerClause.slice(Math.max(0, idx)))
          .filter((w) => contentStems(w).length > 0 && !VERBS.has(w) && !/^\d/.test(w) && !/^(percent|cent|pounds|dollars|euros|billion|million|thousand)$/.test(w));
        const unitNoun = n.unit && !/[%£$€]/.test(n.unit) ? n.unit : undefined;
        const subjectWords = before.length ? before.slice(-3) : unitNoun ? [unitNoun] : after.length ? after.slice(0, 2) : lastSubject.slice(-2);
        const subject = subjectWords.join(' ') || topicKeys[0] || 'figure';
        const keys = [...new Set([...subjectWords, ...(unitNoun && !subjectWords.includes(unitNoun) ? [unitNoun] : []), ...after.slice(0, 2)].map(stem))];
        const falling = FALLING.test(lowerClause.slice(0, Math.max(0, idx)));
        const value = falling && n.unit === '%' ? -Math.abs(n.value) : n.value;
        const c: ClaimJudgment = {
          subject, keys, value, kind: COMMITMENT.test(sent) ? 'commitment' : 'fact', text: sent,
          ...(n.unit ? { unit: n.unit } : {}), ...(year ? { year } : {}),
        };
        const k = this.contradicts(c, clause, h, st);
        if (k) c.contradicts = k;
        out.push(c);
        break; // one claim per clause
      }
    }
    return out;
  }

  private contradicts(c: ClaimJudgment, clause: string, h: Heard, st: DetectState): ClaimJudgment['contradicts'] | undefined {
    // Against what this same speaker said before.
    const mine = st.claims.filter((x) => x.speaker === h.speaker && x.status === 'standing').reverse();
    for (const prior of mine) {
      const same = keyOverlap(clause, prior.keys) >= 0.5 || jaccard(c.keys, prior.keys) >= 0.5;
      if (!same || !unitsMatch(c.unit, prior.unit) || prior.value === undefined || c.value === undefined) continue;
      if (relDiff(c.value, prior.value) >= 0.25) {
        return { claimId: prior.id, kind: prior.kind === 'commitment' ? 'moving_goalposts' : 'changed_claim' };
      }
      if (prior.kind === 'commitment' && prior.year && c.year && prior.year !== c.year) {
        return { claimId: prior.id, kind: 'moving_goalposts' };
      }
      break; // the latest matching claim is the one that stands
    }
    // Against the evidence pack.
    for (const e of st.evidence) {
      if (e.value === undefined || c.value === undefined) continue;
      if (keyOverlap(clause, e.keys) < 0.5 && jaccard(c.keys, e.keys.map(stem)) < 0.5) continue;
      if (!unitsMatch(c.unit, e.unit)) continue;
      const tol = e.tolerance ?? 0.15;
      const diff = e.value === 0 ? Math.abs(c.value) / 100 : relDiff(c.value, e.value);
      if (diff > tol) return { evidenceId: e.id, kind: 'evidence' };
    }
    return undefined;
  }

  // --------------------------------------------------------------- diversions

  diversion(
    text: string, h: Heard, st: DetectState, topic: string | null,
    answered: QuestionView | undefined, contradiction: ClaimJudgment | undefined,
  ): Judgment['diversion'] | undefined {
    const cand: { type: DiversionType; confidence: number; why: string; questionId?: string; claimId?: string }[] = [];
    if (contradiction?.contradicts?.kind === 'changed_claim' && contradiction.contradicts.claimId) {
      cand.push({ type: 'changed_claim', confidence: 0.8, why: 'same speaker, same subject, a different number', claimId: contradiction.contradicts.claimId });
    }
    if (contradiction?.contradicts?.kind === 'moving_goalposts' && contradiction.contradicts.claimId) {
      cand.push({ type: 'moving_goalposts', confidence: 0.75, why: 'a commitment restated with a different target', claimId: contradiction.contradicts.claimId });
    }
    if (cues.goalposts(text)) {
      const commitment = [...st.claims].reverse().find((c) => c.speaker === h.speaker && c.kind === 'commitment'
        && (keyOverlap(text, c.keys) >= 0.34 || (topic !== null && keyOverlap(text, st.current.keys) > 0)));
      if (commitment) cand.push({ type: 'moving_goalposts', confidence: 0.7, why: 'a weaker test for the same commitment', claimId: commitment.id });
    }
    if (cues.adHominem(text)) cand.push({ type: 'ad_hominem', confidence: 0.7, why: 'about the person, not the point' });
    if (cues.whatabout(text) && !answered) cand.push({ type: 'whataboutism', confidence: 0.65, why: "answered with the other side's record" });
    // Answering a different question: one is open for this speaker, and this is not its answer.
    const open = st.questions.filter((q) => q.status === 'open' && q.to === h.speaker && q.by !== h.speaker);
    const q = open[open.length - 1];
    if (q && !answered) {
      const offTopic = topic !== null && q.topic !== null && topic !== q.topic && keyOverlap(text, q.keys) < 0.34;
      if (offTopic || cues.deflect(text)) {
        cand.push({ type: 'deflection', confidence: offTopic && cues.deflect(text) ? 0.75 : 0.6, why: `the question put to them was “${q.text}”`, questionId: q.id });
      }
    }
    cand.sort((a, b) => b.confidence - a.confidence);
    return cand[0];
  }

  // -------------------------------------------------------------------- shift

  shift(text: string, h: Heard, st: DetectState, topic: string | null, keys: string[], div: DiversionType | undefined, toHepta: boolean): ShiftType {
    if (div === 'ad_hominem' || div === 'whataboutism' || div === 'deflection') return 'diversion';
    const cur = st.current.topic;
    if (toHepta || !cur || !topic || topic === cur) return 'none';
    if (keyOverlap(text, st.current.keys) >= 0.5) return 'none';
    const role = st.speakers.find((s) => s.id === h.speaker)?.role;
    if (cues.transition(text)) return 'natural';
    if (cues.link(text)) return 'follow_up';
    // Raised a moment ago, or a line of thought already open: following it up.
    const recent = st.turns.slice(-2).map((t) => t.text).join(' ');
    if (keys.some((k) => contentStems(recent).includes(stem(k)))) return 'follow_up';
    if (st.threads.some((t) => t.topic === topic)) return 'follow_up';
    return role === 'moderator' ? 'natural' : 'follow_up';
  }

  // ----------------------------------------------------------------- readings

  readings(
    text: string, h: Heard, st: DetectState, shift: ShiftType,
    div: Judgment['diversion'] | undefined, answered: QuestionView | undefined, topic: string | null,
  ): Reading[] {
    const scores: Record<string, number> = {};
    const add = (k: string, v: number) => { scores[k] = Math.max(scores[k] ?? 0, v); };
    const settled = h.final;
    if (div) add(`diversion:${div.type}`, settled ? div.confidence + 0.25 : div.confidence);
    else if (shift !== 'none') add(shift, 0.6);
    // The sentence might still turn into an answer, or stay where it was.
    add(answered ? 'answer' : 'none', settled ? (div ? 0.25 : 0.9) : answered ? 0.7 : 0.45);
    if (!settled) {
      const open = st.questions.some((q) => q.status === 'open' && q.to === h.speaker);
      if (open && !answered && !div) add('diversion:deflection', cues.deflect(text) ? 0.5 : 0.15);
      if (topic && st.current.topic && topic !== st.current.topic && shift === 'none') add('follow_up', 0.2);
    }
    const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(scores)
      .map(([label, s]) => ({ label, p: round(s / total) }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3);
  }
}

// ---------------------------------------------------------------------- helpers

function ignored(kind: 'ad' | 'crowd' | 'backchannel'): Judgment {
  return {
    topic: null, topicKeys: [], shiftType: 'none', addressedToHepta: false, ignore: kind,
    readings: [{ label: `ignore:${kind}`, p: 1 }], confidence: 0.9,
  };
}

function unitsMatch(a?: string, b?: string): boolean {
  const pct = (u?: string) => u === '%';
  return pct(a) === pct(b);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const POLAR_ANSWER = /^(yes|no|yeah|yep|nope|absolutely|definitely|mostly|partly|not (yet|really|at all)|of course|certainly|we will|we won'?t|we are|we're|we aren'?t|it will|it won'?t|it should|it shouldn'?t|it is|it isn'?t|i will|i won'?t|we have no plans|no plans|there will|there won'?t)\b/i;
const FUNDING_ANSWER = /\b(paid for by|funded (by|through|from)|pay for (it|them|this) (by|through|with)|by closing|by raising|by cutting|comes? (from|out of)|through (a|the|new)|out of (the|our))\b/i;

/** How well a sentence answers a question. Crude by design: the model tier does this properly. */
export function answerScore(text: string, q: QuestionView, topic: string | null): number {
  const t = text.trim();
  if (cues.deflect(t) && !FUNDING_ANSWER.test(t)) return 0.1;
  const qs = q.text.toLowerCase();
  const overlap = Math.max(keyOverlap(t, q.keys), jaccard(contentStems(t), q.keys));
  let s = overlap >= 0.34 ? 0.55 : overlap > 0 ? 0.35 : 0.15;
  if (/\bhow (will|would|do|does|is|are|can)\b.*\b(pay|fund|funded|afford|financ)/.test(qs) || /\bwhere does the money\b|\bmoney .* come from\b/.test(qs)) {
    s = FUNDING_ANSWER.test(t) ? 0.9 : 0.1;
  } else if (/\bwhich is it\b|\b(\w+) or (\w+)\?$/.test(qs)) {
    const opts = /(\w+) or (\w+)\??$/.exec(qs);
    s = opts && (new RegExp(`\\b(${opts[1]}|${opts[2]})\\b`, 'i').test(t) || numbers(t).length > 0) ? 0.85 : 0.1;
  } else if (/^(\w+ )?(how (much|many|fast|big|high|long)|what is the (figure|rate|number))/.test(qs.replace(/^[a-z ]+, /, ''))) {
    s = numbers(t).some((n) => !n.year) ? 0.85 : Math.min(s, 0.3);
  } else if (/^(and |so |but )?([a-z ]+, )?(are|is|do|does|did|will|would|can|could|should|have|has|was|were)\b/.test(qs) || /\byes or no\b/.test(qs)) {
    s = POLAR_ANSWER.test(t) ? 0.9 : Math.min(s, 0.3);
  } else if (/^(and )?[a-z ]{1,20}\?$/.test(qs.trim())) {
    // "And inflation?": a subject alone. Answered by talking about it.
    s = keyOverlap(t, q.keys) >= 0.5 ? 0.85 : 0.2;
  } else if (topic !== null && topic === q.topic) {
    s += 0.15;
  }
  return Math.min(1, s);
}
