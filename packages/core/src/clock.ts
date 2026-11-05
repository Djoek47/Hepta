/**
 * Injectable clock. Every timing rule in the spec is tested against FakeClock,
 * so the core is testable with no device and no audio.
 */

// Declared locally so the core needs neither DOM nor Node lib types: it has to
// compile the same for React Native, a browser and a server.
declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (id: unknown) => void;

export type TimerId = number;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as TimerId,
  clearTimeout: (id) => clearTimeout(id),
};

type Scheduled = { id: TimerId; at: number; fn: () => void };

export class FakeClock implements Clock {
  private t: number;
  private seq = 1;
  private queue: Scheduled[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerId {
    const id = this.seq++;
    this.queue.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(id: TimerId): void {
    this.queue = this.queue.filter((s) => s.id !== id);
  }

  /** Advance time, firing every timer whose deadline is reached, in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.queue
        .filter((s) => s.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((s) => s.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }

  get pending(): number {
    return this.queue.length;
  }
}
