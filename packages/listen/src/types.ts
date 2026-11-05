/**
 * The shapes everything in Hepta Listen agrees on.
 *
 * A recognizer delivers SttChunks. The speaker tracker turns each into a
 * Heard (who, what so far, whether a clause just ended). A Detector — the Jev
 * seam — reads a Heard against the conversation so far and returns a
 * Judgment. The rules around it (threads, questions, claims, timing) turn the
 * judgment into a JevDecision: the one record per chunk that the UI shows, the
 * bench scores and the export keeps.
 */

export type Mode = 'conversation' | 'debater' | 'panel';
export type ShiftType = 'none' | 'natural' | 'follow_up' | 'diversion';
export type DiversionType =
  | 'deflection' | 'whataboutism' | 'ad_hominem' | 'question_dodged' | 'moving_goalposts' | 'changed_claim';
export type RespondState = 'listen' | 'note' | 'ready' | 'respond';
/** Audio that is not part of the conversation, or a nod that is not a turn. */
export type IgnoreKind = 'ad' | 'crowd' | 'backchannel';

export type Word = {
  text: string;
  startMs: number;
  endMs: number;
  /** The recognizer's diarization label for this word ('0', 'A', …). */
  speaker?: string | null;
  confidence?: number;
};

/** What a streaming recognizer delivers: the current utterance, so far. */
export type SttChunk = {
  /** The recognizer's id for the utterance this belongs to. Grows until final. */
  utteranceId: string;
  /** The whole utterance so far. Recognizers revise words, so it is re-read whole. */
  text: string;
  /** The utterance has ended (end of speech, not just a stable segment). */
  final: boolean;
  words: Word[];
  startMs: number;
  endMs: number;
  /** Audio time the recognizer has heard up to. Later than the last word when there is silence after it. */
  heardToMs: number;
  /** A non-speech event the recognizer reports (applause, laughter, music). */
  event?: 'applause' | 'laughter' | 'music' | 'noise';
};

export type SpeakerRole = 'moderator' | 'panelist' | 'user';
export type SpeakerInfo = {
  id: string;
  name?: string;
  role?: SpeakerRole;
  /** Heard only in ads or crowd noise so far: not a participant. */
  outside?: 'ad' | 'crowd';
};

/** A chunk with its speaker resolved and its clause boundary judged. */
export type Heard = {
  id: string;
  utteranceId: string;
  /** S1, S2, … */
  speaker: string;
  text: string;
  final: boolean;
  startMs: number;
  endMs: number;
  /** Audio time of this decision point. */
  atMs: number;
  /** The speaker is at a clause boundary now: punctuation, a pause, a joint word, or the end. */
  boundary: boolean;
  words: Word[];
  event?: SttChunk['event'];
};

// ------------------------------------------------------------ conversation state

/** A finished utterance, as the detectors see the conversation so far. */
export type Turn = {
  id: string;
  utteranceId: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  topic: string | null;
  ignored?: IgnoreKind;
};

export type ThreadView = {
  id: string;
  topic: string;
  /** The words this line of thought has been talked about in, most used first (stems). */
  keys: string[];
  /** Decays with a half-life (5 min); +1 while on air, +0.5 each time its words come up elsewhere. */
  weight: number;
  mentions: number;
  /** Who opened it. */
  owner: string;
  openedMs: number;
  lastMs: number;
  /** The subject being talked about now. */
  onAir: boolean;
};

export type QuestionStatus = 'open' | 'answered' | 'dodged';
export type QuestionView = {
  id: string;
  by: string;
  /** Who it was put to. Null when put to everyone, or to someone not yet heard. */
  to: string | null;
  /** The name it was put to, kept until that speaker is heard ("Minister, …" before the minister speaks). */
  toName?: string;
  text: string;
  keys: string[];
  topic: string | null;
  askedMs: number;
  /** How many times it has been asked. */
  asks: number;
  /** Turns the addressee has taken since it was asked, without answering. */
  turnsSince: number;
  status: QuestionStatus;
  answeredBy?: string;
  utteranceId: string;
};

export type ClaimKind = 'fact' | 'commitment';
/**
 * standing: what the speaker said and what stands. contradicts: said later,
 * against a standing claim — it does NOT replace it until settled. superseded:
 * replaced by a settled correction.
 */
export type ClaimStatus = 'standing' | 'contradicts' | 'superseded';
export type ClaimView = {
  id: string;
  speaker: string;
  subject: string;
  keys: string[];
  value?: number;
  unit?: string;
  /** For commitments: the date or deadline it names, if any. */
  year?: number;
  kind: ClaimKind;
  text: string;
  atMs: number;
  utteranceId: string;
  status: ClaimStatus;
  /** For a claim that contradicts: the claim or evidence item it contradicts. */
  against?: { claimId?: string; evidenceId?: string; kind: 'changed_claim' | 'moving_goalposts' | 'evidence' };
};

export type EvidenceItem = {
  id: string;
  subject: string;
  keys: string[];
  value?: number;
  unit?: string;
  text: string;
  source?: string;
  /** Relative difference above which a claim contradicts it. Default 0.15. */
  tolerance?: number;
};

export type StanceSeed = {
  topic: string;
  keys: string[];
  position: string;
  confidence: number;
  evidence: string[];
};

/**
 * What is on air. A diversion that turns on a person or on the other side's
 * record puts that on air for a moment (`about`), without opening a line of
 * thought; `resume` is the subject it left.
 */
export type Current = {
  topic: string | null;
  keys: string[];
  speaker: string | null;
  about?: { kind: 'person' | 'record'; by: string; target: string | null };
  resume?: { topic: string; keys: string[] };
};

/** Everything a detector may read. A copy: holding it gives no way to change the conversation. */
export type DetectState = {
  mode: Mode;
  nowMs: number;
  speakers: SpeakerInfo[];
  /** Recent finished utterances, oldest first. */
  turns: Turn[];
  /** The subject on air before this utterance. */
  current: Current;
  threads: ThreadView[];
  questions: QuestionView[];
  claims: ClaimView[];
  evidence: EvidenceItem[];
  stance?: StanceSeed;
};

// ------------------------------------------------------------------- judgments

/** One reading of a sentence that is not finished yet. */
export type Reading = { label: string; p: number };

export type ClaimJudgment = {
  subject: string;
  keys: string[];
  value?: number;
  unit?: string;
  year?: number;
  kind: ClaimKind;
  text: string;
  /** What it contradicts, as the detector sees it. The rules decide what stands. */
  contradicts?: { claimId?: string; evidenceId?: string; kind: 'changed_claim' | 'moving_goalposts' | 'evidence' };
};

/** What a Detector returns. Judgments only: it decides nothing about speaking. */
export type Judgment = {
  /** The subject of this utterance so far. */
  topic: string | null;
  topicKeys: string[];
  /** Set when the utterance turns on a person or a record instead of the subject. */
  about?: { kind: 'person' | 'record'; target: string | null };
  shiftType: ShiftType;
  diversion?: { type: DiversionType; confidence: number; questionId?: string; claimId?: string; why: string };
  /** The claim worth showing: a contradiction if there is one, else the first. */
  claim?: ClaimJudgment;
  /** Every claim in the utterance. */
  claims?: ClaimJudgment[];
  question?: { text: string; to: string | null; toName?: string; keys: string[]; repeatOf?: string };
  /** The id of an open question this utterance answers. */
  answers?: string;
  addressedToHepta: boolean;
  /** Not part of the conversation, or a nod. */
  ignore?: IgnoreKind;
  /** The readings still alive, best first. Two or three while the sentence is open. */
  readings: Reading[];
  confidence: number;
};

/**
 * The Jev seam. One interface, any backend: local heuristics, a fast model,
 * a hosted typed-decision service. The rules that turn a judgment into a
 * decision do not change when the detector gets better.
 */
export interface Detector {
  readonly name: string;
  /** True only if it runs with no network. */
  readonly local: boolean;
  detect(heard: Heard, state: DetectState, signal?: AbortSignal): Judgment | Promise<Judgment>;
}

// ------------------------------------------------------------------- decisions

export type Quote = { speaker: string; text: string; atMs: number; utteranceId: string };

export type Diversion = {
  type: DiversionType;
  confidence: number;
  questionId?: string;
  claimId?: string;
  /** Who said what, and when: the exact words, never a paraphrase. */
  quotes: Quote[];
  why: string;
};

/** One decision per chunk. What the UI shows, what the bench scores, what the export keeps. */
export type JevDecision = {
  id: string;
  heardId: string;
  utteranceId: string;
  final: boolean;
  speaker: string;
  text: string;
  atMs: number;
  topic: string | null;
  shiftType: ShiftType;
  shiftFrom?: string | null;
  diversion?: Diversion;
  claim?: ClaimJudgment & { id?: string };
  questionId?: string;
  answers?: string;
  /** Questions that became dodged with this utterance (the addressee's Nth turn without an answer). */
  dodged?: string[];
  addressedToHepta: boolean;
  respondState: RespondState;
  confidence: number;
  /** Detector plus rules, wall time. */
  latencyMs: number;
  /** Detector alone. */
  detectorMs: number;
  backend: string;
  /** Made on a partial sentence. */
  provisional: boolean;
  boundary: boolean;
  readings: Reading[];
  ignored?: IgnoreKind;
  /** Why the timing said what it said, for the operator. */
  why?: string;
  /** 'turn-end': a response held for the end of the turn, fired when the speaker went quiet. */
  trigger?: 'chunk' | 'turn-end';
};
