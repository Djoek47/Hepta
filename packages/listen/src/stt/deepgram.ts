/**
 * Deepgram live transcription with diarization, over a WebSocket.
 *
 * Interim results give the current window's words as they settle; is_final
 * marks words that will not change; speech_final and UtteranceEnd mark the end
 * of an utterance. Every word carries a speaker index. KeepAlive is sent when
 * no audio has gone out for a while (Deepgram closes an idle socket), and
 * CloseStream flushes at the end.
 */
import { UtteranceAssembler } from './assemble.js';
import { Emitter, pcmBytes, textOfMessage, wsSocket, type SocketFactory, type SocketLike, type SttProvider, type SttSession } from './provider.js';
import type { Word } from '../types.js';

export type DeepgramOptions = {
  apiKey: string;
  model?: string;
  language?: string;
  /** Silence that ends an utterance. */
  endpointingMs?: number;
  /** Backstop for the end of an utterance when endpointing misses it in noise. */
  utteranceEndMs?: number;
  socket?: SocketFactory | ((url: string, headers: Record<string, string>) => Promise<SocketLike>);
  keepAliveMs?: number;
};

type DgWord = { word: string; punctuated_word?: string; start: number; end: number; confidence?: number; speaker?: number };
type DgMessage =
  | { type: 'Results'; is_final?: boolean; speech_final?: boolean; start?: number; duration?: number; channel?: { alternatives?: { transcript?: string; words?: DgWord[] }[] } }
  | { type: 'UtteranceEnd'; last_word_end?: number }
  | { type: 'SpeechStarted' | 'Metadata' | string };

export function deepgramUrl(o: DeepgramOptions, sampleRate: number, language?: string): string {
  const q = new URLSearchParams({
    model: o.model ?? 'nova-3', language: language ?? o.language ?? 'en', encoding: 'linear16', sample_rate: String(sampleRate), channels: '1',
    interim_results: 'true', punctuate: 'true', smart_format: 'true', diarize: 'true',
    endpointing: String(o.endpointingMs ?? 300), utterance_end_ms: String(o.utteranceEndMs ?? 1000), vad_events: 'true',
  });
  return `wss://api.deepgram.com/v1/listen?${q}`;
}

export function deepgram(o: DeepgramOptions): SttProvider {
  return {
    name: 'deepgram',
    diarizes: 'word',
    async open({ sampleRate, language }): Promise<SttSession> {
      const make = o.socket ?? wsSocket;
      const sock = await make(deepgramUrl(o, sampleRate, language), { Authorization: `Token ${o.apiKey}` });
      const ev = new Emitter();
      const asm = new UtteranceAssembler('dg', (chunk) => ev.emit({ type: 'chunk', chunk }));
      let lastAudio = Date.now();
      let closed = false;
      let opened = false;
      const pending: Uint8Array[] = [];
      const keep = setInterval(() => {
        if (!closed && opened && Date.now() - lastAudio > (o.keepAliveMs ?? 4000)) sock.send(JSON.stringify({ type: 'KeepAlive' }));
      }, Math.min(o.keepAliveMs ?? 4000, 4000));
      const done = new Promise<void>((resolve) => {
        sock.on('close', () => { closed = true; clearInterval(keep); ev.emit({ type: 'close' }); resolve(); });
      });
      sock.on('open', () => { opened = true; for (const p of pending.splice(0)) sock.send(p); ev.emit({ type: 'open' }); });
      sock.on('error', (err) => ev.emit({ type: 'error', error: `deepgram: ${String((err as Error)?.message ?? err)}` }));
      sock.on('message', (data) => {
        let m: DgMessage;
        try { m = JSON.parse(textOfMessage(data)) as DgMessage; } catch { return; }
        if (m.type === 'Results') {
          const r = m as Extract<DgMessage, { type: 'Results' }>;
          const words: Word[] = (r.channel?.alternatives?.[0]?.words ?? []).map((w) => ({
            text: w.punctuated_word ?? w.word, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000),
            speaker: w.speaker === undefined ? null : String(w.speaker), ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
          }));
          const heardTo = Math.round(((r.start ?? 0) + (r.duration ?? 0)) * 1000);
          asm.segment(words, !!r.is_final, !!r.speech_final, heardTo);
        } else if (m.type === 'UtteranceEnd') {
          const e = m as { last_word_end?: number };
          asm.end(Math.round((e.last_word_end ?? 0) * 1000) + (o.utteranceEndMs ?? 1000));
        }
      });
      return {
        send(pcm) {
          if (closed) return;
          lastAudio = Date.now();
          const bytes = pcmBytes(pcm);
          if (opened) sock.send(bytes); else pending.push(new Uint8Array(bytes));
        },
        async finish() {
          if (closed) return;
          sock.send(JSON.stringify({ type: 'CloseStream' }));
          await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
          if (!closed) sock.close();
        },
        close() { closed = true; clearInterval(keep); sock.close(); },
        on: (fn) => ev.on(fn),
      };
    },
  };
}
