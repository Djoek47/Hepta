/**
 * What the conversation holds: the turns, the lines of thought, the questions
 * still open, the claims on record. Written only here, from finished
 * utterances and the judgments made of them; detectors get a copy.
 */
import { contentStems } from './text.js';
import type {
  ClaimJudgment, ClaimView, DetectState, EvidenceItem, Heard, Judgment, Mode, QuestionView, SpeakerInfo, StanceSeed,
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
  readonly threads: ThreadView[] = [];
  readonly questions: QuestionView[] = [];
  readonly claims: ClaimView[] = [];
  current: { topic: string | null; keys: string[]; speaker: string | null } = { topic: null, keys: [], speaker: null };
  private seq = { q: 0, c: 0, t: 0, u: 0 };

  snapshot(mode: Mode, speakers: SpeakerInfo[], nowMs: number, evidence: EvidenceItem[], stance?: StanceSeed): DetectState {
    return {
      mode, nowMs, speakers: speakers.map((s) => ({ ...s })),
      turns: this.turns.slice(-12).map((t) => ({ ...t })),
      current: { ...this.current, keys: [...this.current.keys] },
      threads: this.threads.map((t) => ({ ...t, keys: [...t.keys] })),
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

    // The subject. An utterance put to Hepta is about the programme, not the subject.
    if (j.topic && !j.addressedToHepta) {
      out.topicFrom = this.current.topic;
      this.current = { topic: j.topic, keys: j.topicKeys.length ? j.topicKeys : contentStems(h.text), speaker: h.speaker };
      out.topicTo = j.topic;
      let t = this.threads.find((x) => x.topic === j.topic);
      if (!t) {
        t = { id: `th${++this.seq.t}`, topic: j.topic, keys: [...this.current.keys], weight: 1, owner: h.speaker, openedMs: h.startMs, lastMs: h.endMs, onAir: true };
        this.threads.push(t);
      }
      t.lastMs = h.endMs;
      for (const x of this.threads) x.onAir = x === t;
    }
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
