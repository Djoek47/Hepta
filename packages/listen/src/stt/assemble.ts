/**
 * Recognizers deliver segments; the listener wants utterances. This turns one
 * into the other: finalized words accumulate, the latest interim words ride
 * on top, and the utterance ends at the recognizer's endpoint.
 *
 * It also splits an utterance where the speaker changes. Two people can talk
 * with no pause long enough for an endpoint — crosstalk, a quick reply — and a
 * single "utterance" that holds both is wrong about who said what. A change
 * held for three finalized words is a new speaker; one or two is the diarizer
 * wavering, and the majority vote downstream absorbs it.
 */
import type { SttChunk, Word } from '../types.js';

export const SPLIT_RUN = 3;

export class UtteranceAssembler {
  private finalWords: Word[] = [];
  private interim: Word[] = [];
  private seq = 0;
  private id: string;

  constructor(private readonly prefix: string, private readonly emit: (c: SttChunk) => void) {
    this.id = `${prefix}-${++this.seq}`;
  }

  /** A segment from the recognizer. `isFinal`: these words will not change. `endpoint`: the utterance ended. */
  segment(words: Word[], isFinal: boolean, endpoint: boolean, heardToMs: number): void {
    if (isFinal) {
      this.interim = [];
      for (const w of words) this.finalWords.push(w);
      this.splitOnSpeakerChange(heardToMs);
    } else {
      this.interim = words;
    }
    if (this.finalWords.length + this.interim.length === 0) return;
    this.flush(endpoint, heardToMs);
  }

  /** The recognizer says the utterance is over (an UtteranceEnd after silence). */
  end(heardToMs: number): void {
    if (this.finalWords.length + this.interim.length === 0) return;
    this.flush(true, heardToMs);
  }

  private splitOnSpeakerChange(heardToMs: number): void {
    const ws = this.finalWords;
    if (ws.length < SPLIT_RUN + 2) return;
    const head = majority(ws.slice(0, ws.length - SPLIT_RUN));
    const tail = ws.slice(-SPLIT_RUN);
    const s = tail[0]!.speaker;
    if (s === undefined || s === null || s === head || !tail.every((w) => w.speaker === s)) return;
    // Walk back to where the new speaker's run began.
    let i = ws.length - SPLIT_RUN;
    while (i > 0 && ws[i - 1]!.speaker === s) i--;
    const before = ws.slice(0, i);
    const after = ws.slice(i);
    this.finalWords = before;
    this.interim = [];
    this.flush(true, after[0]!.startMs);
    this.finalWords = after;
    void heardToMs;
  }

  private flush(final: boolean, heardToMs: number): void {
    const words = [...this.finalWords, ...this.interim];
    if (words.length === 0) return;
    this.emit({
      utteranceId: this.id, text: words.map((w) => w.text).join(' '), final, words,
      startMs: words[0]!.startMs, endMs: words[words.length - 1]!.endMs, heardToMs: Math.max(heardToMs, words[words.length - 1]!.endMs),
    });
    if (final) {
      this.finalWords = [];
      this.interim = [];
      this.id = `${this.prefix}-${++this.seq}`;
    }
  }
}

export function majority(words: Word[]): string | null | undefined {
  const votes = new Map<string, number>();
  for (const w of words) if (w.speaker !== undefined && w.speaker !== null) votes.set(w.speaker, (votes.get(w.speaker) ?? 0) + 1);
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
