/**
 * Audio from the page to the studio: the microphone, or a file or URL playing
 * in an <audio>/<video> element (so the operator hears it, at broadcast speed,
 * and the recognizer hears the same thing at the same moment).
 */
import { Downsampler } from './downsample.js';

const TAP = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
    return true;
  }
}
registerProcessor('hepta-tap', Tap);`;

export type Capture = { stop(): void; context: AudioContext; level(): number };

async function tap(ctx: AudioContext, source: AudioNode, onFrame: (pcm: Int16Array) => void): Promise<{ node: AudioWorkletNode; level: () => number }> {
  const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, 'hepta-tap');
  const ds = new Downsampler(ctx.sampleRate, 16_000);
  let peak = 0;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    for (const v of e.data) peak = Math.max(peak * 0.9995, Math.abs(v));
    const pcm = ds.push(e.data);
    if (pcm.length) onFrame(pcm);
  };
  source.connect(node);
  return { node, level: () => peak };
}

export async function captureMic(onFrame: (pcm: Int16Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const t = await tap(ctx, src, onFrame);
  return {
    context: ctx, level: t.level,
    stop() { t.node.disconnect(); for (const tr of stream.getTracks()) tr.stop(); void ctx.close(); },
  };
}

/** A playing media element. Its audio still reaches the speakers. */
export async function captureElement(el: HTMLMediaElement, onFrame: (pcm: Int16Array) => void): Promise<Capture> {
  const ctx = new AudioContext();
  const src = ctx.createMediaElementSource(el);
  src.connect(ctx.destination);
  const t = await tap(ctx, src, onFrame);
  return {
    context: ctx, level: t.level,
    stop() { t.node.disconnect(); el.pause(); void ctx.close(); },
  };
}
