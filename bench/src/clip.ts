/**
 * The bench's ground truth. A clip is a conversation with labels on every
 * turn; the bench plays it through the pipeline and scores what Hepta did
 * against what the labels say.
 *
 * Scripted clips carry their text and the simulator turns it into what a
 * streaming recognizer would deliver (partials, finals, diarization labels,
 * diarization mistakes). Recorded clips (real TV material) carry an audio file
 * and turns with times instead; the same labels apply. See bench/clips/README.md.
 */

export type ShiftLabel = 'none' | 'natural' | 'follow_up' | 'diversion';
export type DiversionLabel = 'deflection' | 'whataboutism' | 'ad_hominem' | 'moving_goalposts' | 'changed_claim';

export type ClipTurn = {
  id: string;
  /** The true speaker: a key of `Clip.speakers`. AD and CROWD are not part of the conversation. */
  speaker: string;
  text: string;
  /** Recorded clips only: where the turn is in the audio. */
  startMs?: number;
  endMs?: number;

  /** Canonical subject of the turn. Free text; only changes of it are scored. */
  topic?: string;
  /** How the subject changed from the previous conversational turn. Default 'none'. */
  shift?: ShiftLabel;
  /** Diversion types any one of which is a correct reading of this turn. */
  diversion?: DiversionLabel[];
  /** This turn asks a question. `to` is a speaker key, or null when put to everyone. */
  question?: { id: string; to: string | null; repeat?: boolean; dodged?: boolean };
  /** This turn answers that question. */
  answers?: string;
  /** A checkable claim made in this turn. */
  claim?: { id: string; subject: string; value?: number; unit?: string; kind?: 'fact' | 'commitment' };
  /** This turn contradicts an earlier claim by the same speaker, or an item in the evidence pack. */
  contradicts?: { of: string; kind: 'changed_claim' | 'moving_goalposts' | 'evidence' };
  /** Audio that is not part of the conversation. */
  ignore?: 'ad' | 'crowd';
  /** "yeah", "mm": a listener's nod, not a turn. */
  backchannel?: boolean;
  /** Addressed to Hepta (a direct question, or a moderator's cue). */
  addressed?: boolean;
  /** About the programme rather than the subject ("back after the break"). Not scored for shifts. */
  meta?: boolean;
  /**
   * What Hepta should do here. 'respond': answer when this turn ends.
   * 'cut': may take the floor at a clause boundary inside this turn, or at its end.
   * 'quiet' (default): any response here is out of turn.
   */
  hepta?: 'respond' | 'cut' | 'quiet';
  /** Starts this many ms before the previous turn ends (crosstalk). */
  overlapMs?: number;
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

export type Clip = {
  id: string;
  title: string;
  mode: 'conversation' | 'debater' | 'panel';
  speakers: Record<string, { name?: string; role?: 'moderator' | 'panelist' | 'user' | 'ad' | 'crowd'; wpm?: number }>;
  evidence?: EvidenceItem[];
  /** Debater mode: the view Hepta argues. */
  stance?: { topic: string; keys: string[]; position: string; confidence: number; evidence: string[] };
  /** A question not answered within this many of the addressee's turns is dodged. Default 2. */
  dodgeTurns?: number;
  /** Diarization mistakes the simulator makes. Defaults in the simulator. */
  noise?: { seed?: number; onsetLag?: number; flicker?: number; revisions?: number };
  /** Recorded clips: the audio, relative to the clip file. */
  audio?: string;
  turns: ClipTurn[];
  /** Where this clip came from, and what it is for. */
  note?: string;
};
