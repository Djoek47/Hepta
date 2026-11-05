/**
 * What the conversation holds: the turns, the lines of thought, the questions
 * still open, the claims on record. Written only here, from finished
 * utterances and the judgments made of them; detectors get a copy.
 */
import { contentStems, jaccard, keyOverlap, relDiff } from './text.js';
import { Threads } from './threads.js';
import type {
  ClaimJudgment, ClaimView, Current, DetectState, EvidenceItem, Heard, Judgment, Mode, QuestionView, SpeakerInfo, StanceSeed,
  ThreadView, Turn,
} from './types.js';

export type Committed = {
  turn: Turn;
  /** Questions that became dodged when the addressee's turn ended with this utterance's arrival. */
  dodged: QuestionView[];
  /** A claim settled by the speaker's own correction: the old one is superseded. */
  settled?: { from: ClaimView; to: ClaimView };
  /** A question first asked here. */
  asked?: QuestionView;
  /** A question asked again here. */
  reasked?: QuestionView;
  answered?: QuestionView;
  claims: ClaimView[];
  /** The subject on air before and after. */
  topicFrom: string | null;
  topicTo: string | null;
};

export class Memory {
  readonly turns: Turn[] = [];
  readonly threadBook: Threads;
  readonly questions: QuestionView[] = [];
  readonly claims: ClaimView[] = [];
  current: Current = { topic: null, keys: [], speaker: null };
  private seq = { q: 0, c: 0, t: 0, u: 0 };
  private lastMs = 0;
  /** The turn in progress: one speaker's run of sentences, until someone else speaks. */
  private turn: { speaker: string; startedMs: number; answered: Set<string> } | null = null;

  /**
   * @param dodgeTurns a question put to someone who then takes this many turns
   *   without answering it is dodged. Nods and ads are not turns.
   */
  constructor(halfLifeMs?: number, readonly dodgeTurns = 2) {
    this.threadBook = new Threads(halfLifeMs);
  }

  /** Threads as of the latest audio heard. */
  get threads(): ThreadView[] {
    return this.threadBook.view(this.lastMs);
  }

  snapshot(mode: Mode, speakers: SpeakerInfo[], nowMs: number, evidence: EvidenceItem[], stance?: StanceSeed): DetectState {
    return {
      mode, nowMs, speakers: speakers.map((s) => ({ ...s })),
      turns: this.turns.slice(-12).map((t) => ({ ...t })),
      current: structuredClone(this.current),
      threads: this.threadBook.view(Math.max(this.lastMs, nowMs)),
      questions: this.questions.map((q) => ({ ...q, keys: [...q.keys] })),
      claims: this.claims.map((c) => ({ ...c, keys: [...c.keys] })),
      evidence,
      ...(stance ? { stance } : {}),
    };
  }

  /** A finished utterance. */
  commit(h: Heard, j: Judgment): Committed {
    const turn: Turn = {
      id: `u${++this.seq.u}`, utteranceId: h.utteranceId, speaker: h.speaker, text: h.text,
      startMs: h.startMs, endMs: h.endMs, topic: j.ignore ? null : j.topic,
      ...(j.ignore ? { ignored: j.ignore } : {}),
    };
    this.turns.push(turn);
    this.lastMs = Math.max(this.lastMs, h.endMs);
    const out: Committed = { turn, claims: [], dodged: [], topicFrom: this.current.topic, topicTo: this.current.topic };
    if (j.ignore) return out;

    // Someone else speaking ends the turn in progress: count it against what was put to that speaker.
    if (!this.turn || this.turn.speaker !== h.speaker) {
      if (this.turn) out.dodged = this.closeTurn(this.turn);
      this.turn = { speaker: h.speaker, startedMs: h.startMs, answered: new Set() };
    }

    // Questions. A late answer to a dodged question still counts as an answer.
    if (j.answers) {
      const q = this.questions.find((x) => x.id === j.answers);
      if (q && (q.status === 'open' || q.status === 'dodged')) {
        q.status = 'answered';
        q.answeredBy = h.speaker;
        out.answered = q;
        this.turn.answered.add(q.id);
      }
    }
    if (j.question) {
      const again = j.question.repeatOf ? this.questions.find((x) => x.id === j.question!.repeatOf) : undefined;
      if (again) {
        again.asks++;
        out.reasked = again;
      } else {
        const q: QuestionView = {
          id: `q${++this.seq.q}`, by: h.speaker, to: j.question.to, text: j.question.text, keys: j.question.keys,
          topic: j.topic, askedMs: h.startMs, asks: 1, turnsSince: 0, status: 'open', utteranceId: h.utteranceId,
          ...(j.question.toName ? { toName: j.question.toName } : {}),
        };
        this.questions.push(q);
        out.asked = q;
      }
    }

    // Claims. A contradiction is recorded next to what it contradicts, never over it —
    // unless the speaker corrects themselves out loud, which settles it.
    for (const c of j.claims ?? (j.claim ? [j.claim] : [])) {
      const v = this.record(h, c);
      out.claims.push(v);
      if (v.status === 'contradicts' && CORRECTION.test(h.text) && v.against?.claimId) {
        const from = this.claims.find((x) => x.id === v.against!.claimId);
        if (from) out.settled = { from, to: this.settle(v.id)! };
      }
    }

    // The subject. A cue to Hepta has none: it is about the programme.
    if (!j.topic) return out;
    out.topicFrom = this.current.topic;
    out.topicTo = j.topic;
    if (j.about) {
      // Turning on a person or a record: on air for a moment, not a line of thought.
      const resume = this.current.about ? this.current.resume : this.current.topic ? { topic: this.current.topic, keys: this.current.keys } : undefined;
      this.current = { topic: j.topic, keys: [], speaker: h.speaker, about: { ...j.about, by: h.speaker }, ...(resume ? { resume } : {}) };
      this.threadBook.offAir();
      return out;
    }
    const t = this.threadBook.on(j.topic, j.topicKeys, h.text, h.speaker, h.startMs, h.endMs);
    this.current = { topic: j.topic, keys: t.keys.length ? t.keys : j.topicKeys.length ? j.topicKeys : contentStems(h.text), speaker: h.speaker };
    return out;
  }

  /** A speaker has a name now: questions put to that name are theirs. */
  bindNames(speakers: SpeakerInfo[]): void {
    for (const q of this.questions) {
      if (q.to !== null || !q.toName) continue;
      const name = q.toName;
      const hits = speakers.filter((s) => s.id !== q.by && s.name && (s.name.toLowerCase() === name || s.name.toLowerCase().endsWith(` ${name}`)));
      if (hits.length === 1) q.to = hits[0]!.id;
    }
  }

  /** The turn in progress is over (end of session). */
  flush(): QuestionView[] {
    const t = this.turn;
    this.turn = null;
    return t ? this.closeTurn(t) : [];
  }

  private closeTurn(turn: { speaker: string; startedMs: number; answered: Set<string> }): QuestionView[] {
    const dodged: QuestionView[] = [];
    for (const q of this.questions) {
      if (q.status !== 'open' || q.to !== turn.speaker || q.askedMs >= turn.startedMs || turn.answered.has(q.id)) continue;
      q.turnsSince++;
      if (q.turnsSince >= this.dodgeTurns) {
        q.status = 'dodged';
        dodged.push(q);
      }
    }
    return dodged;
  }

  /**
   * A contradicting claim is settled: it stands now, and what it contradicted is
   * superseded. The only way a claim changes by more than a revision — by the
   * speaker's own correction, or by the operator.
   */
  settle(claimId: string): ClaimView | undefined {
    const c = this.claims.find((x) => x.id === claimId);
    if (!c) return undefined;
    const old = c.against?.claimId ? this.claims.find((x) => x.id === c.against!.claimId) : undefined;
    if (old) old.status = 'superseded';
    c.status = 'standing';
    return c;
  }

  private record(h: Heard, c: ClaimJudgment): ClaimView {
    const v: ClaimView = {
      id: `c${++this.seq.c}`, speaker: h.speaker, subject: c.subject, keys: c.keys, kind: c.kind, text: c.text,
      atMs: h.startMs, utteranceId: h.utteranceId, status: c.contradicts && c.contradicts.kind !== 'evidence' ? 'contradicts' : 'standing',
      ...(c.value !== undefined ? { value: c.value } : {}), ...(c.unit ? { unit: c.unit } : {}), ...(c.year ? { year: c.year } : {}),
      ...(c.contradicts ? { against: c.contradicts } : {}),
    };
    // A small revision of what this speaker said ("to be precise, 4.1") updates it.
    if (v.status === 'standing' && v.value !== undefined) {
      for (const p of this.claims) {
        if (p.speaker !== v.speaker || p.status !== 'standing' || p.value === undefined) continue;
        const same = keyOverlap(v.text, p.keys) >= 0.5 || jaccard(v.keys, p.keys) >= 0.5;
        if (same && (p.unit === '%') === (v.unit === '%') && relDiff(p.value, v.value) < 0.25) p.status = 'superseded';
      }
    }
    this.claims.push(v);
    return v;
  }
}

/** The speaker taking back what they said, out loud. */
export const CORRECTION = /\b(sorry,? i meant|i meant to say|let me correct|correction|i misspoke|to correct (myself|that)|my mistake|i should have said)\b/i;
