import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAudio, ffmpegDecode, pace, readWav, resample, toPcm16 } from '../src/audio.js';

/** A stereo 16-bit WAV: a 440 Hz tone on the left, silence on the right. */
function wav(rate: number, seconds: number): Uint8Array {
  const frames = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + frames * 4);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) dv.setInt16(44 + i * 4, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000), true);
  return new Uint8Array(buf);
}

describe('audio for the recognizer', () => {
  it('reads a stereo WAV and mixes it to mono', () => {
    const w = readWav(wav(44100, 0.5));
    expect(w).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(w.mono.length).toBe(22050);
    expect(Math.max(...w.mono)).toBeCloseTo(16000 / 32768 / 2, 2);
  });

  it('resamples to 16 kHz and converts to 16-bit', () => {
    const w = readWav(wav(48000, 1));
    const pcm = toPcm16(resample(w.mono, 48000, 16000));
    expect(pcm.length).toBe(16000);
    expect(pcm).toBeInstanceOf(Int16Array);
  });

  it('decodes a file to 16 kHz mono, natively for WAV and through ffmpeg otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hepta-audio-'));
    const p = join(dir, 'tone.wav');
    writeFileSync(p, wav(22050, 1));
    expect((await decodeAudio(p)).length).toBe(16000);
    let ffmpeg = true;
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
    if (ffmpeg) {
      const mp3 = join(dir, 'tone.mp3');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', p, mp3]);
      const pcm = await ffmpegDecode(mp3);
      expect(Math.abs(pcm.length - 16000)).toBeLessThan(2000); // mp3 frames pad the ends
    }
  });

  it('paces audio in real time, or faster when asked', async () => {
    const pcm = new Int16Array(16000); // one second
    const frames: number[] = [];
    const t0 = performance.now();
    await pace(pcm, (f) => frames.push(f.length), { speed: 20 });
    const ms = performance.now() - t0;
    expect(frames.reduce((a, b) => a + b, 0)).toBe(16000);
    expect(frames).toHaveLength(10);
    expect(ms).toBeGreaterThan(30);
    expect(ms).toBeLessThan(400);
  });
});
