/**
 * One operator's session: a recognizer feeding a listener, and every event
 * the listener produces sent back to the page. Audio arrives as binary frames
 * (16 kHz PCM from the page's microphone or a file it is playing); a scripted
 * clip needs no audio at all.
 */
import {
  exportSession, Listener, MARKS, type Clip, type EvidenceItem, type JevDecision, type Mark, type MarkKind, type Mode, type SpeakerRole, type StanceSeed,
  type SttProvider, type SttSession, type HaikuTiming,
} from '@hepta/listen';
import { detectorFor, responderFor, scriptedFor, sttFor, type Env } from './config.js';

export type StartMessage = {
  type: 'start';
  input: 'mic' | 'file' | 'url' | 'script';
  mode?: Mode;
  backend?: 'heuristic' | 'jev-haiku';
  responder?: 'sonnet' | 'template';
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
  | { type: 'name'; speaker: string; name?: string; role?: SpeakerRole }
  | { type: 'speaking'; on: boolean }
  | { type: 'mark'; target: string; on: Mark['on']; mark: MarkKind; note?: string }
  | { type: 'cue' }
  | { type: 'settle'; claimId: string }
  | { type: 'export' };

export type Send = (msg: Record<string, unknown>) => void;

export class Session {
  listener: Listener | null = null;
  private stt: SttSession | null = null;
  /** Audio time of the last chunk, and when it arrived: the clock a held answer waits on. */
  private heardTo = { audioMs: 0, wallMs: 0, speed: 1 };
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly marks: Mark[] = [];
  private meta: Record<string, unknown> = {};
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
    if (msg.type === 'speaking') { this.listener?.setSpeaking(msg.on); return; }
    if (msg.type === 'mark') {
      if (!MARKS.includes(msg.mark)) return;
      const i = this.marks.findIndex((m) => m.target === msg.target);
      const mark: Mark = { target: msg.target, on: msg.on, mark: msg.mark, ...(msg.note ? { note: msg.note.slice(0, 500) } : {}), at: new Date().toISOString() };
      if (i >= 0) this.marks[i] = mark; else this.marks.push(mark);
      this.send({ type: 'marked', mark });
      return;
    }
    if (msg.type === 'cue') { this.listener?.cue(); return; }
    if (msg.type === 'settle') { if (this.listener?.settle(msg.claimId)) this.send({ type: 'settled', claimId: msg.claimId, claims: this.listener.memory.claims }); return; }
    if (msg.type === 'export') {
      if (!this.listener) { this.send({ type: 'error', message: 'nothing to export yet' }); return; }
      this.send({ type: 'export', data: exportSession(this.listener, this.meta, this.marks) });
      return;
    }
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
        mode, detector: detectorFor(m.backend, this.env, (t) => this.timings.push(t)), responder: responderFor(m.responder, this.env),
        ...(evidence ? { evidence } : {}), ...(stance ? { stance } : {}),
      });
      this.listener = listener;
      listener.on((e) => {
        if (e.type === 'heard') this.send({ type: 'heard', heard: e.heard });
        else if (e.type === 'insight') this.send({ type: 'insight', insight: e.insight });
        else if (e.type === 'response') this.send({ type: 'response', card: { ...e.card, ledger: undefined } });
        else if (e.type === 'floor') this.send({ type: 'floor', floor: e.floor, why: e.why });
        else this.send({ type: 'decision', decision: e.decision, speakers: listener.speakers.list(), threads: listener.memory.threads, questions: listener.memory.questions });
      });
      const provider = this.providerFor(m, this.clip);
      const stt = await provider.open({ sampleRate: m.sampleRate ?? 16_000 });
      this.stt = stt;
      const named = new Set<string>();
      this.heardTo = { audioMs: 0, wallMs: Date.now(), speed: m.input === 'script' ? m.speed ?? 1 : 1 };
      // Nobody speaking is time passing too: a held answer is given once the speaker has been quiet.
      this.ticker = setInterval(() => {
        const now = this.heardTo.audioMs + (Date.now() - this.heardTo.wallMs) * this.heardTo.speed;
        if (this.heardTo.audioMs > 0) void listener.tick(now);
      }, 100);
      stt.on((e) => {
        if (e.type === 'chunk') {
          this.heardTo = { ...this.heardTo, audioMs: e.chunk.heardToMs, wallMs: Date.now() };
          if (this.clip) this.nameFromClip(listener, e.chunk.words.map((w) => w.speaker), named);
          listener.hear(e.chunk).catch((err: unknown) => this.send({ type: 'error', message: String((err as Error)?.message ?? err) }));
        } else if (e.type === 'speech') listener.speechStarted(e.atMs);
        else if (e.type === 'error') this.send({ type: 'error', message: e.error });
        else if (e.type === 'open') this.send({ type: 'status', stt: 'open', provider: provider.name });
        else if (e.type === 'close') this.send({ type: 'status', stt: 'closed', provider: provider.name, ...(e.reason ? { reason: e.reason } : {}) });
      });
      this.marks.length = 0;
      this.meta = { input: m.input, stt: provider.name, responder: responderFor(m.responder, this.env).name, startedAt: new Date().toISOString(), ...(this.clip ? { clip: this.clip.id } : {}), ...(m.speed ? { speed: m.speed } : {}) };
      this.send({ type: 'started', mode, input: m.input, backend: listener.detector.name, stt: provider.name, responder: responderFor(m.responder, this.env).name, ...(this.clip ? { clip: { id: this.clip.id, title: this.clip.title } } : {}) });
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
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
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
