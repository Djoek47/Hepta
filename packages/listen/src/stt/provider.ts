/**
 * Speech in, chunks out. One interface for every recognizer, so a live
 * diarizing service, a recorded file and a scripted clip all reach the
 * listener the same way.
 */
import type { SttChunk } from '../types.js';

export type SttEvent =
  | { type: 'open' }
  | { type: 'chunk'; chunk: SttChunk }
  | { type: 'error'; error: string }
  | { type: 'close'; reason?: string };

export interface SttSession {
  /** 16-bit little-endian PCM, mono, at the sample rate the session was opened with. */
  send(pcm: Int16Array): void;
  /** No more audio: flush what the recognizer holds, then close. */
  finish(): Promise<void>;
  close(): void;
  on(fn: (e: SttEvent) => void): () => void;
}

export interface SttProvider {
  readonly name: string;
  /** How speakers come back: per word, per turn, or not at all. */
  readonly diarizes: 'word' | 'turn' | 'none';
  open(opts: { sampleRate: number; language?: string }): Promise<SttSession>;
}

/** The part of a WebSocket the adapters use, so tests can play recorded messages. */
export type SocketLike = {
  send(data: string | Uint8Array): void;
  close(): void;
  on(event: 'open', fn: () => void): void;
  on(event: 'message', fn: (data: unknown) => void): void;
  on(event: 'close', fn: (code?: number, reason?: unknown) => void): void;
  on(event: 'error', fn: (err: unknown) => void): void;
};
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

/** The default socket: the `ws` package, which can send auth headers. */
export async function wsSocket(url: string, headers: Record<string, string>): Promise<SocketLike> {
  const { default: WebSocket } = await import('ws');
  return new WebSocket(url, { headers }) as unknown as SocketLike;
}

export class Emitter {
  private readonly fns = new Set<(e: SttEvent) => void>();
  on(fn: (e: SttEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(e: SttEvent): void {
    for (const fn of this.fns) fn(e);
  }
}

export function textOfMessage(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return String(data);
}

export function pcmBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
