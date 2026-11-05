/**
 * Who is speaking. The recognizer's diarization labels ('0', '1', 'A') become
 * S1, S2… in the order people first speak, and stay that way: an operator can
 * name them once ("S1 is the moderator") and the names hold.
 *
 * A chunk's speaker is the majority of its words, weighted by how long each
 * word lasted. Diarizers are least sure at the edges of a turn — the first
 * word of a new speaker often carries the old one's label — and a vote over
 * the whole utterance absorbs that instead of splitting a sentence in two.
 */
import type { SpeakerInfo, SpeakerRole, SttChunk } from './types.js';

export class SpeakerTracker {
  private readonly ids = new Map<string, string>();
  private readonly info = new Map<string, SpeakerInfo>();
  private last: string | null = null;

  /** The S-id for a chunk. */
  resolve(chunk: SttChunk): string {
    const votes = new Map<string, number>();
    for (const w of chunk.words) {
      if (w.speaker === undefined || w.speaker === null) continue;
      votes.set(w.speaker, (votes.get(w.speaker) ?? 0) + Math.max(40, w.endMs - w.startMs));
    }
    const label = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const id = label === undefined ? (this.last ?? this.idFor('unknown')) : this.idFor(label);
    this.last = id;
    return id;
  }

  idFor(label: string): string {
    let id = this.ids.get(label);
    if (!id) {
      id = `S${this.ids.size + 1}`;
      this.ids.set(label, id);
      // An operator may have named this speaker before they spoke: keep it.
      if (!this.info.has(id)) this.info.set(id, { id });
    }
    return id;
  }

  /** The recognizer label behind an S-id. */
  labelOf(id: string): string | undefined {
    for (const [label, sid] of this.ids) if (sid === id) return label;
    return undefined;
  }

  name(id: string, name?: string, role?: SpeakerRole): void {
    const cur = this.info.get(id) ?? { id };
    this.info.set(id, { ...cur, ...(name !== undefined ? { name } : {}), ...(role !== undefined ? { role } : {}) });
  }

  /**
   * What a finished utterance turned out to be. A voice heard only in ads or
   * crowd noise is marked as outside the conversation; one real sentence
   * makes it a participant for good.
   */
  heard(id: string, ignored: 'ad' | 'crowd' | 'backchannel' | undefined): void {
    const c = this.counts.get(id) ?? { talk: 0, ad: 0, crowd: 0 };
    if (ignored === 'ad' || ignored === 'crowd') c[ignored]++;
    else if (ignored === undefined) c.talk++;
    this.counts.set(id, c);
    const info = this.info.get(id) ?? { id };
    if (c.talk === 0 && c.ad + c.crowd > 0) info.outside = c.ad >= c.crowd ? 'ad' : 'crowd';
    else delete info.outside;
    this.info.set(id, info);
  }

  private readonly counts = new Map<string, { talk: number; ad: number; crowd: number }>();

  get(id: string): SpeakerInfo | undefined {
    return this.info.get(id);
  }

  list(): SpeakerInfo[] {
    return [...this.info.values()];
  }
}
