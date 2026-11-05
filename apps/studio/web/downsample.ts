/**
 * Float audio at the device's rate → 16 kHz 16-bit PCM, in pieces, keeping
 * its place between pieces so frame edges do not click. Pure, so it is tested
 * in Node; the AudioWorklet only taps samples and hands them over.
 */
export class Downsampler {
  private pos = 0;
  private carry: Float32Array = new Float32Array(0);
  constructor(private readonly from: number, private readonly to = 16_000) {}

  push(input: Float32Array): Int16Array {
    const x = new Float32Array(this.carry.length + input.length);
    x.set(this.carry, 0);
    x.set(input, this.carry.length);
    const ratio = this.from / this.to;
    const out: number[] = [];
    while (this.pos + ratio <= x.length) {
      // Average the input samples this output sample covers: a box low-pass on the way down.
      const a = Math.floor(this.pos);
      const b = Math.min(x.length, Math.floor(this.pos + ratio));
      let s = 0;
      for (let i = a; i < Math.max(a + 1, b); i++) s += x[i]!;
      const v = s / Math.max(1, b - a);
      out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
      this.pos += ratio;
    }
    const used = Math.floor(this.pos);
    this.carry = x.slice(used);
    this.pos -= used;
    return Int16Array.from(out);
  }
}
