/**
 * Audio for the recognizers: 16 kHz, mono, 16-bit PCM, delivered in real time.
 *
 * WAV is read here with no dependencies. Anything else (mp3, mp4, a TV clip)
 * goes through ffmpeg when it is installed. A recorded clip is paced at the
 * speed it was broadcast — that is the point of testing on real material: a
 * listener that is only right when it gets the whole file at once is not
 * listening.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const RATE = 16_000;

export type Pcm = { sampleRate: number; samples: Int16Array };

/** PCM 8/16/24/32-bit and float32 WAV, any channel count, mixed down to mono. */
export function readWav(buf: Uint8Array): { sampleRate: number; channels: number; mono: Float32Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      const bytes = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * fmt.channels));
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytes;
          let v: number;
          if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(p, true);
          else if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
          else if (fmt.bits === 24) v = ((buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16)) << 8 >> 8) / 8388608;
          else if (fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
          else if (fmt.bits === 8) v = (buf[p]! - 128) / 128;
          else throw new Error(`unsupported WAV: ${fmt.bits}-bit format ${fmt.format}`);
          sum += v;
        }
        mono[i] = sum / fmt.channels;
      }
      return { sampleRate: fmt.rate, channels: fmt.channels, mono };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Resample with a box filter on the way down and linear interpolation. Enough for speech recognition. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(x.length / ratio));
  const half = Math.max(0, Math.floor(ratio / 2));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    if (half > 0) {
      let s = 0;
      let n = 0;
      for (let k = i0 - half; k <= i0 + half; k++) if (k >= 0 && k < x.length) { s += x[k]!; n++; }
      out[i] = n ? s / n : 0;
    } else {
      const f = pos - i0;
      out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? x[i0] ?? 0) * f;
    }
  }
  return out;
}

export function toPcm16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)));
  return out;
}

/** Any file or URL ffmpeg can read, as 16 kHz mono PCM. */
export function ffmpegDecode(input: string, rate = RATE): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', input, '-f', 's16le', '-ac', '1', '-ar', String(rate), '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => parts.push(d));
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', (e) => reject(new Error(`ffmpeg is needed for ${input}: ${e.message}`)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${err.trim()}`));
      const b = Buffer.concat(parts);
      resolve(new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)));
    });
  });
}

/** A recording as 16 kHz mono PCM: WAV natively, everything else through ffmpeg. */
export async function decodeAudio(pathOrUrl: string, rate = RATE): Promise<Int16Array> {
  if (/\.wav$/i.test(pathOrUrl) && !/^https?:/i.test(pathOrUrl)) {
    const w = readWav(await readFile(pathOrUrl));
    return toPcm16(resample(w.mono, w.sampleRate, rate));
  }
  return ffmpegDecode(pathOrUrl, rate);
}

/**
 * Send PCM in frames, in real time (or `speed` times faster). Resolves when
 * the last frame is sent, or when the signal aborts.
 */
export async function pace(pcm: Int16Array, send: (frame: Int16Array) => void, opts: { rate?: number; frameMs?: number; speed?: number; signal?: AbortSignal } = {}): Promise<void> {
  const rate = opts.rate ?? RATE;
  const frame = Math.round((rate * (opts.frameMs ?? 100)) / 1000);
  const speed = opts.speed ?? 1;
  const t0 = performance.now();
  for (let i = 0; i < pcm.length; i += frame) {
    if (opts.signal?.aborted) return;
    send(pcm.subarray(i, Math.min(pcm.length, i + frame)));
    const due = ((i + frame) / rate) * 1000 / speed;
    const wait = due - (performance.now() - t0);
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
  }
}
