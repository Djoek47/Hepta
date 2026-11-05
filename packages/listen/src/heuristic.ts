/**
 * The local backend: tier 0. Word overlap, numbers and surface cues, weighed
 * against what the conversation already holds (open questions, earlier
 * claims, the evidence pack). Microseconds, no network — the baseline every
 * model-backed detector has to beat, and the fallback when one is late.
 */
import { buildLexicon, topicsIn, type Lexicon, type TopicHit } from './lexicon.js';
import { addressesHepta, adScore, asksForTheFloor, cues, isCrowd, isNod, isQuestion, mentionsHepta, questionSentences, refersToQuestion } from './cues.js';
import { contentStems, jaccard, keyOverlap, numbers, relDiff, sentences, stem, words, endsInOpenNumber } from './text.js';
import { CORRECTION } from './memory.js';
import type {
  ClaimJudgment, DetectState, Detector, DiversionType, Heard, Judgment, QuestionView, Reading, ShiftType,
} from './types.js';

/** Verbs that sit between a subject and its number and are not the subject. */
const VERBS = new Set(['build', 'builds', 'built', 'bring', 'brings', 'raise', 'raises', 'raised', 'cut', 'cuts', 'rise', 'rises', 'rose',
  'fall', 'falls', 'fell', 'falling', 'gone', 'grow', 'grows', 'growing', 'grew', 'running', 'run', 'runs', 'hit', 'reach', 'reached', 'spend',
  'spent', 'pay', 'paid', 'save', 'teach', 'come', 'came', 'drop', 'dropped', 'went', 'keep', 'kept', 'increase', 'increased', 'decrease',
  'reduce', 'reduced', 'double', 'doubled', 'halve', 'halved', 'stand', 'stands', 'sits', 'take', 'cost', 'costs', 'closing', 'going',
  'expect', 'feel', 'feels', 'leave', 'leaves', 'tried', 'try', 'clearing', 'bringing', 'helping', 'look', 'looked']);

const DETERMINER = /^(the|a|an|its|our|their|his|her|my|your|this|that|real|total|net)$/;
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
    const addressedToHepta = addressesHepta(text) || (conversation && isQuestion(text));

    // ---- questions and answers
    const question = addressedToHepta ? undefined : this.questionIn(text, h, st);
    const answered = this.answering(text, h, st);

    // ---- claims
    const claims = this.claimsIn(text, h, st, st.current.keys);
    const contradiction = claims.find((c) => c.contradicts);

    // ---- diversions the words themselves show
    let div = this.markedDiversion(text, h, st, answered, contradiction);

    // ---- what it is about
    const subject = this.subjectOf(text, h, st, answered, div?.type, addressedToHepta);
    const { topic, keys } = subject;

    // ---- answering a different question
    if (!div) div = this.deflection(text, h, st, topic, answered);

    // ---- shift
    const shiftType = this.shift(text, h, st, subject, div?.type);

    // ---- readings: what this sentence could still turn out to be
    const readings = this.readings(text, h, st, shiftType, div, answered, topic);
    const top = readings[0]!;

    const j: Judgment = {
      topic, topicKeys: keys, shiftType, addressedToHepta, readings,
      confidence: Math.min(0.95, top.p),
      ...(subject.about ? { about: subject.about } : {}),
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

  /**
   * The subject of an utterance, with continuity: most sentences carry on the
   * subject on air, and a sentence names a new one only with weight — a strong
   * word, or several, or a cue that says so ("let's turn to", "on council tax").
   * An answer stays with its question. Turning on a person or the other side's
   * record puts that on air for a moment, and the subject returns after it.
   */
  subjectOf(text: string, h: Heard, st: DetectState, answered: QuestionView | undefined, marked: DiversionType | undefined, toHepta: boolean):
    { topic: string | null; keys: string[]; about?: { kind: 'person' | 'record'; target: string | null } } {
    const hits = topicsIn(text, this.stateLexicon(st));
    const stems = contentStems(text);
    // A cue to Hepta is about the programme, not the subject (in conversation, it is the subject).
    if (toHepta && st.mode !== 'conversation' && (hits[0]?.score ?? 0) < 2) return { topic: null, keys: [] };
    if (marked === 'ad_hominem') {
      const target = this.target(text, h, st);
      return { topic: `about ${this.nameOf(target, st)}`, keys: [], about: { kind: 'person', target } };
    }
    if (marked === 'whataboutism') {
      const target = this.target(text, h, st);
      return { topic: `${this.nameOf(target, st)}'s record`, keys: [], about: { kind: 'record', target } };
    }
    if (refersToQuestion(text)) {
      const q = [...st.questions].reverse().find((x) => x.topic && x.status === 'open' && (x.to === h.speaker || x.by === h.speaker || x.to !== null));
      if (q?.topic) return { topic: q.topic, keys: q.keys };
    }
    if (answered?.topic) return { topic: answered.topic, keys: this.keysOf(answered.topic, st, answered.keys) };

    // What carries on: the subject on air, or — after a diversion — the one it left,
    // unless this is the person it turned on, answering back.
    const cur = st.current;
    const replying = cur.about && cur.about.target === h.speaker;
    const base = cur.about && !replying ? cur.resume ?? null : cur.topic ? { topic: cur.topic, keys: cur.keys } : null;
    const best = hits[0];
    const named = (b: TopicHit) => ({ topic: b.topic, keys: this.keysOf(b.topic, st, b.keys.concat(stems.slice(0, 4))) });

    if (cues.transition(text) || cues.steer(text)) {
      if (best) return named(best);
      if (!base && stems.length >= 2) return this.fresh(text, stems);
    }
    if (!base) {
      if (cur.about && replying) return { topic: cur.topic, keys: [] };
      if (best) return named(best);
      return stems.length >= 2 ? this.fresh(text, stems) : { topic: null, keys: [] };
    }
    if (replying && (!best || best.score < 3)) return { topic: cur.topic, keys: [] };
    if (!best || best.topic === base.topic) return { topic: base.topic, keys: base.keys };
    const baseScore = hits.find((x) => x.topic === base.topic)?.score ?? 0;
    const onAirWords = stems.filter((x) => base.keys.includes(x)).length / Math.max(1, stems.length);
    const off = onAirWords < 0.25;
    // One strong word in a question is asked within the subject; in a statement, off the subject, it moves it.
    const single = best.score < 3;
    // Naming a line of thought already open is a return, even in a question ("What about the trip?").
    const known = st.threads.some((t) => t.topic === best.topic);
    const moves = best.score >= 2 && best.score > baseScore
      && ((off && (!single || !isQuestion(text) || known)) || best.score - baseScore >= 3);
    return moves ? named(best) : { topic: base.topic, keys: base.keys };
  }

  private fresh(text: string, stems: string[]): { topic: string; keys: string[] } {
    const ws = words(text).filter((w) => stems.includes(stem(w)) && !VERBS.has(w));
    return { topic: ws.slice(0, 2).join(' ') || stems.slice(0, 2).join(' '), keys: stems.slice(0, 6) };
  }

  private keysOf(topic: string, st: DetectState, extra: string[]): string[] {
    const t = st.threads.find((x) => x.topic === topic);
    return [...new Set([...(t?.keys ?? []), ...extra.map(stem)])].slice(0, 16);
  }

  /** Who a diversion turns on: a speaker named in it, else the one being answered. */
  private target(text: string, h: Heard, st: DetectState): string | null {
    if (/\b(a |the )?(chatbot|machine|computer|hepta)\b/i.test(text)) return 'hepta';
    const s = text.toLowerCase();
    const named = st.speakers.filter((p) => p.id !== h.speaker && p.name).sort((a, b) => b.name!.length - a.name!.length)
      .find((p) => s.includes(p.name!.toLowerCase()));
    if (named) return named.id;
    for (let i = st.turns.length - 1; i >= 0; i--) {
      const t = st.turns[i]!;
      if (t.speaker !== h.speaker && !t.ignored) return t.speaker;
    }
    return null;
  }

  private nameOf(id: string | null, st: DetectState): string {
    if (id === 'hepta') return 'Hepta';
    if (!id) return 'the other side';
    const s = st.speakers.find((x) => x.id === id);
    return s?.name ? `the ${s.name.toLowerCase()}` : id;
  }

  private lexCache: { key: string; lex: Lexicon } | null = null;
  /** Tonight's subject — the stance, the evidence pack — joins the lexicon and is preferred. */
  private stateLexicon(st: DetectState): Lexicon {
    if (st.evidence.length === 0 && !st.stance) return this.lex;
    const key = `${st.stance?.topic ?? ''}|${st.evidence.map((e) => e.id).join(',')}`;
    if (this.lexCache?.key === key) return this.lexCache.lex;
    const extra: Record<string, string[]> = { ...this.baseLex };
    if (st.stance) extra[st.stance.topic] = [...(extra[st.stance.topic] ?? []), ...st.stance.keys];
    const lex = buildLexicon(extra, st.stance ? [st.stance.topic] : []);
    this.lexCache = { key, lex };
    return lex;
  }

  // ---------------------------------------------------------------- questions

  /** A speaker named in a sentence (by name, or by a role said alone: "Minister, …"). 'all' for the whole panel. */
  private namedIn(text: string, h: Heard, st: DetectState): string | 'all' | null {
    const s = text.toLowerCase();
    if (/^(panel|everyone|all of you|both of you)\b/.test(s)) return 'all';
    const named = st.speakers
      .filter((p) => p.id !== h.speaker && p.name)
      .map((p) => ({ id: p.id, name: p.name!.toLowerCase() }))
      .sort((a, b) => b.name.length - a.name.length);
    for (const p of named) {
      if (new RegExp(`(^|[,.]\\s*|\\s)${escape(p.name)}(,|\\?|\\.|\\s|$)`).test(s)) return p.id;
    }
    const voc = /^([a-z ]{3,30}),/.exec(s)?.[1]?.trim();
    if (voc) {
      const hit = named.find((p) => p.name.endsWith(voc));
      if (hit) return hit.id;
    }
    // A role's head word said to them ("…on track, minister, yes or no?"), when only one speaker has it.
    const heads = new Map<string, string[]>();
    for (const p of named) {
      const head = p.name.split(/\s+/).pop()!;
      if (head.length >= 4) heads.set(head, [...(heads.get(head) ?? []), p.id]);
    }
    for (const [head, ids] of heads) {
      if (ids.length === 1 && new RegExp(`(^|[,.]\\s*)(the )?${escape(head)}\\s*(,|\\?|\\.|$)`).test(s)) return ids[0]!;
    }
    return null;
  }

  /**
   * Who a sentence is put to: a name said to them — in this sentence, or in the
   * one just before it in the same turn ("Minister, the question was about
   * funding. Where does the money come from?") — or else whoever spoke last.
   */
  addressee(text: string, h: Heard, st: DetectState): string | null {
    const here = this.namedIn(text, h, st);
    if (here === 'all') return null;
    if (here) return here;
    const prev = st.turns[st.turns.length - 1];
    if (prev && prev.speaker === h.speaker && !prev.ignored && h.startMs - prev.endMs < 2500) {
      const before = this.namedIn(prev.text, h, st);
      if (before === 'all') return null;
      if (before) return before;
    }
    for (let i = st.turns.length - 1; i >= 0; i--) {
      const t = st.turns[i]!;
      if (t.speaker !== h.speaker && !t.ignored) return t.speaker;
    }
    return null;
  }

  questionIn(text: string, h: Heard, st: DetectState): Judgment['question'] | undefined {
    const qs = questionSentences(text).filter((q) => !asksForTheFloor(q));
    const reask = /\bthe question was\b/i.test(text);
    if (qs.length === 0 && !reask) return undefined;
    const q = qs[qs.length - 1] ?? text;
    const to = this.addressee(text, h, st);
    // Put to someone by name who has not spoken yet: keep the name, and bind it when they do.
    const voc = to === null ? /^([a-z][a-z ]{2,30}),/i.exec(text.trim())?.[1]?.toLowerCase() : undefined;
    const toName = voc && !/^(panel|everyone|all of you|both of you|so|and|but|well|now|okay|look|tonight)$/.test(voc) ? voc : undefined;
    const keys = [...new Set(contentStems(q))];
    // "Minister, the question was about funding. Where does the money come from?": a question
    // rephrased in the turn that just re-asked one is that question again.
    const prev = st.turns[st.turns.length - 1];
    const sameTurnReask = !reask && prev && prev.speaker === h.speaker && h.startMs - prev.endMs < 2500 && refersToQuestion(prev.text);
    // Asked again — by the same person or someone else — while still open.
    const open = st.questions.filter((x) => (x.status === 'open' || x.status === 'dodged') && x.to !== h.speaker && (to === null || x.to === to));
    const repeat = open
      .map((x) => ({ x, o: Math.max(jaccard(keys, x.keys), keyOverlap(q, x.keys)) }))
      .filter((y) => reask || sameTurnReask || y.o >= 0.25)
      .sort((a, b) => b.o - a.o || b.x.askedMs - a.x.askedMs)[0];
    return { text: q, to, keys, ...(toName ? { toName } : {}), ...(repeat ? { repeatOf: repeat.x.id } : {}) };
  }

  /** A "Yes." right after a yes-or-no question put to this speaker is an answer, not a nod. */
  private answersPolarNow(text: string, h: Heard, st: DetectState): boolean {
    if (!/^(yes|no|yeah|yep|nope)\b/i.test(text.trim())) return false;
    const last = [...st.questions].reverse().find((q) => q.status === 'open' && q.by !== h.speaker);
    return !!last && (last.to === h.speaker || last.to === null) && h.startMs - last.askedMs < 15_000;
  }

  /** The open question this sentence answers, if any. */
  answering(text: string, h: Heard, st: DetectState): QuestionView | undefined {
    const open = st.questions.filter((q) => (q.status === 'open' || q.status === 'dodged') && q.by !== h.speaker && (q.to === h.speaker || q.to === null));
    // The best answer wins; between equals, the question asked last.
    let best: { q: QuestionView; s: number } | undefined;
    for (const q of open) {
      const s = answerScore(text, q, { adjacent: this.firstTurnAfter(q, h, st), onTopic: !st.current.about && (q.topic === null || q.topic === st.current.topic) })
        + 0.05 * keyOverlap(text, q.keys);
      if (s >= 0.5 && (!best || s >= best.s)) best = { q, s };
    }
    return best?.q;
  }

  /** Nobody else has spoken since the question: this is the addressee's first turn after it. */
  private firstTurnAfter(q: QuestionView, h: Heard, st: DetectState): boolean {
    const i = st.turns.findIndex((t) => t.utteranceId === q.utteranceId);
    if (i < 0) return false;
    return st.turns.slice(i + 1).every((t) => t.ignored || t.speaker === h.speaker || t.speaker === q.by);
  }

  // ------------------------------------------------------------------- claims

  claimsIn(text: string, h: Heard, st: DetectState, topicKeys: string[]): ClaimJudgment[] {
    if (!h.final && endsInOpenNumber(text)) return []; // "four…" may still become "four hundred"
    const out: ClaimJudgment[] = [];
    let prevContent: string[] = [];
    for (const sentence of sentences(text)) {
      const sent = sentence.trim();
      if (!sent) continue;
      let lastSubject = prevContent;
      prevContent = words(sent).filter((w) => contentStems(w).length > 0 && !VERBS.has(w));
      if (isQuestion(sent) || REPORTED.test(sent)) continue;
      for (const clause of sent.split(/,\s+|;\s+|\s+(?:and|but|because|so)\s+/i)) {
        const nums = numbers(clause);
        const n = nums.find((x) => !x.year);
        if (!n) continue;
        const year = nums.find((x) => x.year)?.value;
        const lowerClause = clause.toLowerCase();
        const idx = lowerClause.indexOf(n.raw.toLowerCase().split(' ')[0]!.replace(/[£$€]/, ''));
        // A verb-looking word after a determiner is a noun: "the real cost is 5 percent".
        const pre = words(lowerClause.slice(0, Math.max(0, idx)));
        const before = pre.filter((w, i) => contentStems(w).length > 0 && (!VERBS.has(w) || DETERMINER.test(pre[i - 1] ?? '') || DETERMINER.test(pre[i - 2] ?? '')));
        const after = words(lowerClause.slice(Math.max(0, idx)))
          .filter((w) => contentStems(w).length > 0 && !VERBS.has(w) && !/^\d/.test(w) && !/^(percent|cent|pounds|dollars|euros|billion|million|thousand)$/.test(w));
        const unitNoun = n.unit && !/[%£$€]/.test(n.unit) ? n.unit : undefined;
        // No subject in this clause ("…, no sorry, 400 like we said"): the one just named carries over.
        const subjectWords = before.length ? before.slice(-3) : unitNoun ? [unitNoun] : after.length ? after.slice(0, 2) : lastSubject.slice(-2);
        lastSubject = subjectWords;
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
        out.push(c); // one claim per clause: its first figure
      }
    }
    // Said twice in one breath ("650, no sorry, 400 like we said"): the last word on a subject stands.
    return out.filter((c, i) => !out.slice(i + 1).some((d) => jaccard(c.keys, d.keys) >= 0.5 || d.subject === c.subject));
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

  /** Diversions the words show by themselves, given what this speaker said before. */
  markedDiversion(text: string, h: Heard, st: DetectState, answered: QuestionView | undefined, contradiction: ClaimJudgment | undefined): Judgment['diversion'] | undefined {
    const cand: NonNullable<Judgment['diversion']>[] = [];
    // Correcting oneself out loud is not changing the story.
    const corrected = CORRECTION.test(text);
    if (!corrected && contradiction?.contradicts?.kind === 'changed_claim' && contradiction.contradicts.claimId) {
      cand.push({ type: 'changed_claim', confidence: 0.8, why: 'same speaker, same subject, a different number', claimId: contradiction.contradicts.claimId });
    }
    if (contradiction?.contradicts?.kind === 'moving_goalposts' && contradiction.contradicts.claimId) {
      cand.push({ type: 'moving_goalposts', confidence: 0.75, why: 'a commitment restated with a different target', claimId: contradiction.contradicts.claimId });
    }
    if (cues.goalposts(text)) {
      const commitment = [...st.claims].reverse().find((c) => c.speaker === h.speaker && c.kind === 'commitment'
        && (keyOverlap(text, c.keys) >= 0.34 || keyOverlap(text, st.current.keys.slice(0, 6)) > 0));
      if (commitment) cand.push({ type: 'moving_goalposts', confidence: 0.7, why: 'a weaker test for the same commitment', claimId: commitment.id });
    }
    // An attack made while a question is open leaves that question open: say which.
    const open = st.questions.filter((q) => q.status === 'open' && q.to === h.speaker && q.by !== h.speaker).pop();
    const pending = open && !answered ? { questionId: open.id } : {};
    if (cues.adHominem(text)) cand.push({ type: 'ad_hominem', confidence: 0.7, why: 'about the person, not the point', ...pending });
    if (cues.whatabout(text) && !answered) cand.push({ type: 'whataboutism', confidence: 0.65, why: "answered with the other side's record", ...pending });
    cand.sort((a, b) => b.confidence - a.confidence);
    return cand[0];
  }

  /** Answering a different question: one is open for this speaker, and this is not its answer. */
  deflection(text: string, h: Heard, st: DetectState, topic: string | null, answered: QuestionView | undefined): Judgment['diversion'] | undefined {
    if (answered) return undefined;
    const open = st.questions.filter((q) => q.status === 'open' && q.to === h.speaker && q.by !== h.speaker);
    const q = open[open.length - 1];
    if (!q) return undefined;
    const offTopic = topic !== null && q.topic !== null && topic !== q.topic && keyOverlap(text, q.keys) < 0.34;
    if (!offTopic && !cues.deflect(text)) return undefined;
    return { type: 'deflection', confidence: offTopic && cues.deflect(text) ? 0.75 : 0.6, why: `the question put to them was “${q.text}”`, questionId: q.id };
  }

  // -------------------------------------------------------------------- shift

  shift(text: string, h: Heard, st: DetectState, subject: { topic: string | null; keys: string[]; about?: unknown }, div: DiversionType | undefined): ShiftType {
    const { topic, keys } = subject;
    if (topic === null) return 'none';
    if (subject.about) return st.current.about && st.current.topic === topic ? 'none' : 'diversion';
    const cur = st.current;
    if (!cur.topic || topic === cur.topic) return 'none';
    if (div === 'deflection') return 'diversion';
    if (cues.transition(text)) return 'natural';
    if (cues.link(text) || refersToQuestion(text)) return 'follow_up';
    if (cur.about) return 'follow_up'; // back from a diversion to the subject it left
    if (st.threads.some((t) => t.topic === topic)) return 'follow_up'; // a line of thought taken up again
    const recent = st.turns.slice(-2).map((t) => t.text).join(' ');
    if (keys.some((k) => contentStems(recent).includes(stem(k)))) return 'follow_up';
    const role = st.speakers.find((s) => s.id === h.speaker)?.role;
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

const POLAR_START = /^(yes|no|yeah|yep|nope|absolutely|definitely|mostly|partly|not (yet|really|at all|quite)|of course|certainly|no plans|we have no plans|there are no plans)\b/i;
const AUX = ['are', 'is', 'am', 'was', 'were', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'have', 'has', 'shall', 'may', 'might'];
/** The auxiliary a yes-or-no question turns on: "are you on track" → are. */
function auxOf(q: string): string | null {
  const body = q.toLowerCase().replace(/^[a-z ]{2,30},\s*/, '').replace(/^(and|so|but|then|now|okay)\s+/, '');
  const m = /^([a-z']+)\b/.exec(body);
  return m && AUX.includes(m[1]!) ? m[1]! : null;
}
/** "We are", "we're not", "it should", "I would": the answer takes up the question's own verb. */
function takesUp(text: string, aux: string): boolean {
  const s = text.toLowerCase().trim();
  const same: Record<string, string[]> = { are: ['are', "'re", 'am', "'m", 'is'], is: ['is', "'s"], am: ['am', "'m"], do: ['do', 'does'], does: ['does', 'do'],
    did: ['did'], will: ['will', "'ll", "won't"], would: ['would', "'d", "wouldn't"], can: ['can', "can't"], could: ['could', "couldn't"],
    should: ['should', "shouldn't"], have: ['have', "'ve", 'has'], has: ['has', 'have', "'s"], was: ['was'], were: ['were'], shall: ['shall', 'will'] };
  const forms = same[aux] ?? [aux];
  return forms.some((f) => new RegExp(`^(well,? |look,? )?(we|i|it|they|you|he|she|that|this|there)\\s*${f.replace("'", "'?")}(n'?t| not)?\\b`).test(s));
}
const FUNDING_ANSWER = /\b(paid for by|funded (by|through|from)|pay for (it|them|this) (by|through|with)|by closing|by raising|by cutting|comes? (from|out of)|through (a|the|new)|out of (the|our))\b/i;

/**
 * How well a sentence answers a question. Crude by design — the model tier
 * does this properly — but checkable where the question is: a yes-or-no
 * question wants yes, no, or its own verb back; "how much" wants a number;
 * "how will you pay" wants a source; "which, X or Y" wants X or Y. An open
 * question is answered by the next turn of the person it was put to, if that
 * turn stays on the subject and does not open with a deflection.
 */
export function answerScore(text: string, q: QuestionView, ctx: { adjacent: boolean; onTopic: boolean } = { adjacent: false, onTopic: false }): number {
  const t = text.trim();
  if (cues.deflect(t) && !FUNDING_ANSWER.test(t)) return 0.1;
  // Pointing at the other side's record, or at the person, answers nothing.
  if (cues.whatabout(t) || cues.adHominem(t)) return 0.1;
  const qs = q.text.toLowerCase();
  const overlap = Math.max(keyOverlap(t, q.keys), jaccard(contentStems(t), q.keys));
  const aux = auxOf(q.text);
  if (/\bhow (will|would|do|does|is|are|can)\b.*\b(pay|fund|funded|afford|financ)/.test(qs) || /\bwhere does the money\b|\bmoney .* come from\b/.test(qs)) {
    return FUNDING_ANSWER.test(t) ? 0.9 : 0.1;
  }
  const yesNo = /\byes or no\b/.test(qs);
  const polarAux = aux ?? (yesNo ? auxOf(qs.replace(/^[^,]*?\b(are|is|will|would|do|does|did|can|could|should|have|has)\b/, '$1')) : null);
  if (yesNo || (aux && !/\b(\w+) or (\w+)\?$/.test(qs))) {
    return POLAR_START.test(t) || (polarAux !== null && takesUp(t, polarAux)) ? 0.9 : 0.2;
  }
  if (/\bwhich is it\b|\b(\w+) or (\w+)\?$/.test(qs)) {
    const opts = /(\w+) or (\w+)\??$/.exec(qs);
    return opts && (new RegExp(`\\b(${opts[1]}|${opts[2]})\\b`, 'i').test(t) || numbers(t).length > 0) ? 0.85 : 0.1;
  }
  if (/^(\w+ )?(how (much|many|fast|big|high|long)|what is the (figure|rate|number))/.test(qs.replace(/^[a-z ]+, /, ''))) {
    return numbers(t).some((n) => !n.year) ? 0.85 : 0.2;
  }
  if (/^(and )?[a-z ]{1,20}\?$/.test(qs.trim())) {
    // "And inflation?": a subject alone. Answered by talking about it.
    return keyOverlap(t, q.keys) >= 0.5 ? 0.85 : 0.2;
  }
  // An open question: the next turn of the person asked, on the subject, is its answer.
  let s = overlap >= 0.34 ? 0.55 : overlap > 0 ? 0.35 : 0.15;
  if (ctx.adjacent && ctx.onTopic && words(t).length >= 4) s = Math.max(s, 0.6);
  return Math.min(1, s);
}
