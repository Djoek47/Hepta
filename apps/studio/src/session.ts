/**
 * One operator's session: a recognizer feeding a listener, and every event
 * the listener produces sent back to the page. Audio arrives as binary frames
 * (16 kHz PCM from the page's microphone or a file it is playing); a scripted
 * clip needs no audio at all.
 */
import {
  Listener, type Clip, type EvidenceItem, type JevDecision, type Mode, type SpeakerRole, type StanceSeed,
  type SttProvider, type SttSession, type HaikuTiming,
} from '@hepta/listen';
import { detectorFor, scriptedFor, sttFor, type Env } from './config.js';

export type StartMessage = {
  type: 'start';
  input: 'mic' | 'file' | 'url' | 'script';
  mode?: Mode;
  backend?: 'heuristic' | 'jev-haiku';
  stt?: 'deepgram' | 'assemblyai';
  clip?: string;
  speed?: number;
  sampleRate?: number;
  evidence?: EvidenceItem[];
  stance?: StanceSeed;
};

export type ClientMessage =
  | StartMessage
  | { type: 'stop' }
  | { type: 'name'; speaker: string; name?: string; role?: SpeakerRole };

export type Send = (msg: Record<string, unknown>) => void;

export class Session {
  listener: Listener | null = null;
  private stt: SttSession | null = null;
  private clip: Clip | null = null;
  private readonly timings: HaikuTiming[] = [];

  constructor(
    private readonly send: Send,
    private readonly env: Env,
    private readonly clips: Map<string, Clip>,
    /** Swappable for tests. */
    private readonly providerFor: (m: StartMessage, clip: Clip | null) => SttProvider = (m, clip) =>
      m.input === 'script' ? scriptedFor(clip!, m.speed) : sttFor(m.stt, env),
  ) {}

  async handle(msg: ClientMessage): Promise<void> {
    if (msg.type === 'start') return this.start(msg);
    if (msg.type === 'stop') return this.stop();
    if (msg.type === 'name' && this.listener) {
      this.listener.name(msg.speaker, msg.name, msg.role);
      this.send({ type: 'speakers', speakers: this.listener.speakers.list() });
    }
  }

  audio(frame: Int16Array): void {
    this.stt?.send(frame);
  }

  private async start(m: StartMessage): Promise<void> {
    await this.stop();
    try {
      this.clip = m.input === 'script' ? this.clips.get(m.clip ?? '') ?? null : null;
      if (m.input === 'script' && !this.clip) throw new Error(`no clip "${m.clip}"`);
      const mode = m.mode ?? this.clip?.mode ?? 'conversation';
      const evidence = m.evidence ?? this.clip?.evidence;
      const stance = m.stance ?? this.clip?.stance;
      const listener = new Listener({
        mode, detector: detectorFor(m.backend, this.env, (t) => this.timings.push(t)),
        ...(evidence ? { evidence } : {}), ...(stance ? { stance } : {}),
      });
      this.listener = listener;
      listener.on((e) => {
        if (e.type === 'heard') this.send({ type: 'heard', heard: e.heard });
        else this.send({ type: 'decision', decision: e.decision, speakers: listener.speakers.list() });
      });
      const provider = this.providerFor(m, this.clip);
      const stt = await provider.open({ sampleRate: m.sampleRate ?? 16_000 });
      this.stt = stt;
      const named = new Set<string>();
      stt.on((e) => {
        if (e.type === 'chunk') {
          if (this.clip) this.nameFromClip(listener, e.chunk.words.map((w) => w.speaker), named);
          listener.hear(e.chunk).catch((err: unknown) => this.send({ type: 'error', message: String((err as Error)?.message ?? err) }));
        } else if (e.type === 'error') this.send({ type: 'error', message: e.error });
        else if (e.type === 'open') this.send({ type: 'status', stt: 'open', provider: provider.name });
        else if (e.type === 'close') this.send({ type: 'status', stt: 'closed', provider: provider.name, ...(e.reason ? { reason: e.reason } : {}) });
      });
      this.send({ type: 'started', mode, input: m.input, backend: listener.detector.name, stt: provider.name, ...(this.clip ? { clip: { id: this.clip.id, title: this.clip.title } } : {}) });
    } catch (err) {
      this.send({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
  }

  /** A scripted clip knows who its speakers are; name them as an operator would. */
  private nameFromClip(listener: Listener, labels: (string | null | undefined)[], named: Set<string>): void {
    const clip = this.clip!;
    const order = Object.keys(clip.speakers);
    // The simulator assigns labels '0', '1', … in order of first appearance in the turns.
    const firstSeen: string[] = [];
    for (const t of clip.turns) if (!firstSeen.includes(t.speaker)) firstSeen.push(t.speaker);
    for (const lab of labels) {
      if (lab === undefined || lab === null || named.has(lab)) continue;
      named.add(lab);
      const truth = firstSeen[Number(lab)];
      const info = truth ? clip.speakers[truth] : undefined;
      if (info?.role === 'moderator' || info?.role === 'panelist' || info?.role === 'user') {
        listener.name(listener.speakers.idFor(lab), info.name, info.role);
      }
    }
    void order;
  }

  async stop(): Promise<void> {
    const stt = this.stt;
    this.stt = null;
    if (stt) {
      try { await Promise.race([stt.finish(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* closing anyway */ }
      stt.close();
    }
  }

  decisions(): JevDecision[] {
    return this.listener?.decisions ?? [];
  }
}
