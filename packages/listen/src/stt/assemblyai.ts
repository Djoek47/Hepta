/**
 * AssemblyAI Universal-Streaming (v3) with speaker labels, over a WebSocket.
 *
 * Each Turn message carries the whole turn so far; end_of_turn closes it, and
 * with format_turns a formatted copy (punctuation, casing) follows — that copy
 * is taken as the final. Speakers come per turn ('A', 'B', or 'UNKNOWN' on
 * turns too short to call); the label is given to every word of the turn.
 * Field names are read defensively (speaker_label or speaker) because the
 * service's documentation has used both.
 */
import { Emitter, pcmBytes, textOfMessage, wsSocket, type SocketFactory, type SocketLike, type SttProvider, type SttSession } from './provider.js';
import type { SttChunk, Word } from '../types.js';

export type AssemblyAiOptions = {
  apiKey: string;
  /** e.g. 'universal-streaming-english'. Omitted: the service default. */
  model?: string;
  maxSpeakers?: number;
  socket?: SocketFactory | ((url: string, headers: Record<string, string>) => Promise<SocketLike>);
};

type AaiWord = { text: string; start: number; end: number; confidence?: number; word_is_final?: boolean; speaker?: string; speaker_label?: string };
type AaiTurn = {
  type: 'Turn'; turn_order: number; turn_is_formatted?: boolean; end_of_turn?: boolean; transcript?: string; words?: AaiWord[];
  speaker_label?: string; speaker?: string;
};

export function assemblyAiUrl(o: AssemblyAiOptions, sampleRate: number): string {
  const q = new URLSearchParams({ sample_rate: String(sampleRate), encoding: 'pcm_s16le', format_turns: 'true', speaker_labels: 'true' });
  if (o.model) q.set('speech_model', o.model);
  if (o.maxSpeakers) q.set('max_speakers', String(o.maxSpeakers));
  return `wss://streaming.assemblyai.com/v3/ws?${q}`;
}

/** One Turn message as a chunk. Exported for tests. */
export function turnChunk(t: AaiTurn, formatting: boolean): SttChunk | null {
  const label = t.speaker_label ?? t.speaker;
  const speaker = label && label !== 'UNKNOWN' ? label : null;
  const ws: Word[] = (t.words ?? []).map((w) => ({
    text: w.text, startMs: Math.round(w.start), endMs: Math.round(w.end),
    speaker: w.speaker_label ?? w.speaker ?? speaker, ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
  }));
  if (ws.length === 0 && !t.transcript) return null;
  const final = !!t.end_of_turn && (!formatting || !!t.turn_is_formatted);
  const text = t.turn_is_formatted && t.transcript ? t.transcript : ws.map((w) => w.text).join(' ');
  const startMs = ws[0]?.startMs ?? 0;
  const endMs = ws[ws.length - 1]?.endMs ?? startMs;
  return { utteranceId: `aai-${t.turn_order}`, text, final, words: ws, startMs, endMs, heardToMs: endMs + (final ? 300 : 80) };
}

export function assemblyai(o: AssemblyAiOptions): SttProvider {
  return {
    name: 'assemblyai',
    diarizes: 'turn',
    async open({ sampleRate }): Promise<SttSession> {
      const make = o.socket ?? wsSocket;
      const sock = await make(assemblyAiUrl(o, sampleRate), { Authorization: o.apiKey });
      const ev = new Emitter();
      let closed = false;
      let opened = false;
      const pending: Uint8Array[] = [];
      const done = new Promise<void>((resolve) => {
        sock.on('close', () => { closed = true; ev.emit({ type: 'close' }); resolve(); });
      });
      sock.on('open', () => { opened = true; for (const p of pending.splice(0)) sock.send(p); ev.emit({ type: 'open' }); });
      sock.on('error', (err) => ev.emit({ type: 'error', error: `assemblyai: ${String((err as Error)?.message ?? err)}` }));
      sock.on('message', (data) => {
        let m: { type?: string } & Partial<AaiTurn>;
        try { m = JSON.parse(textOfMessage(data)); } catch { return; }
        if (m.type === 'Turn') {
          const c = turnChunk(m as AaiTurn, true);
          if (c) ev.emit({ type: 'chunk', chunk: c });
        } else if (m.type === 'Error' || (m as { error?: string }).error) {
          ev.emit({ type: 'error', error: `assemblyai: ${(m as { error?: string }).error ?? 'error'}` });
        }
      });
      return {
        send(pcm) {
          if (closed) return;
          const bytes = pcmBytes(pcm);
          if (opened) sock.send(bytes); else pending.push(new Uint8Array(bytes));
        },
        async finish() {
          if (closed) return;
          sock.send(JSON.stringify({ type: 'Terminate' }));
          await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
          if (!closed) sock.close();
        },
        close() { closed = true; sock.close(); },
        on: (fn) => ev.on(fn),
      };
    },
  };
}
