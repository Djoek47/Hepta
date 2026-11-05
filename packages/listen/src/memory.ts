/**
 * What the conversation holds: the turns, the lines of thought, the questions
 * still open, the claims on record. Written only here, from finished
 * utterances and the judgments made of them; detectors get a copy.
 */
import { contentStems } from './text.js';
import { Threads } from './threads.js';
import type {
  ClaimJudgment, ClaimView, Current, DetectState, EvidenceItem, Heard, Judgment, Mode, QuestionView, SpeakerInfo, StanceSeed,
  ThreadView, Turn,
} from './types.js';

export type Committed = {
  turn: Turn;
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

  constructor(halfLifeMs?: number) {
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
    const out: Committed = { turn, claims: [], topicFrom: this.current.topic, topicTo: this.current.topic };
    if (j.ignore) return out;

    // Questions.
    if (j.answers) {
      const q = this.questions.find((x) => x.id === j.answers);
      if (q && q.status === 'open') {
        q.status = 'answered';
        q.answeredBy = h.speaker;
        out.answered = q;
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
        };
        this.questions.push(q);
        out.asked = q;
      }
    }

    // Claims. A contradiction is recorded next to what it contradicts, never over it.
    for (const c of j.claims ?? (j.claim ? [j.claim] : [])) out.claims.push(this.record(h, c));

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

  private record(h: Heard, c: ClaimJudgment): ClaimView {
    const v: ClaimView = {
      id: `c${++this.seq.c}`, speaker: h.speaker, subject: c.subject, keys: c.keys, kind: c.kind, text: c.text,
      atMs: h.startMs, utteranceId: h.utteranceId, status: c.contradicts && c.contradicts.kind !== 'evidence' ? 'contradicts' : 'standing',
      ...(c.value !== undefined ? { value: c.value } : {}), ...(c.unit ? { unit: c.unit } : {}), ...(c.year ? { year: c.year } : {}),
      ...(c.contradicts ? { against: c.contradicts } : {}),
    };
    this.claims.push(v);
    return v;
  }
}
