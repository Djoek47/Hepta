import { describe, expect, it } from 'vitest';
import { Lines, type Decision, type Heard } from '../src/lines.js';

/** A sentence arriving word by word, `gap` ms apart. */
function say(lines: Lines, text: string, start: number, gap = 250, ctx = { leader: null as string | null, leaderRadius: null as string | null }) {
  const words = text.split(' ');
  const out: { heard: Heard; d: Decision }[] = [];
  for (let i = 1; i <= words.length; i++) {
    const heard = { text: words.slice(0, i).join(' '), final: i === words.length, atMs: start + i * gap };
    out.push({ heard, d: lines.hear(heard, ctx) });
  }
  return out;
}

const firstCut = (seq: { heard: Heard; d: Decision }[]) => seq.find((x) => x.d.kind === 'interrupt');

describe('remembering what was said', () => {
  it('picks a claim out of a finished sentence', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    expect(l.all).toHaveLength(1);
    expect(l.all[0]).toMatchObject({ kind: 'claim', topic: 'grocery budget', value: 400 });
  });

  it('updates the claim rather than keeping two versions of it', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    say(l, 'my grocery budget is 450', 10_000);
    expect(l.all).toHaveLength(1);
    expect(l.all[0]!.value).toBe(450);
  });
});

describe('cutting in', () => {
  it('waits for the end of a clause, then cuts in on a contradiction', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    const seq = say(l, 'this month the grocery budget can go to 600 and then', 60_000);
    const cut = firstCut(seq);
    expect(cut).toBeDefined();
    // not on the number itself, mid-phrase — on the "and" after it
    expect(cut!.heard.text.endsWith('600')).toBe(false);
    expect(cut!.heard.text.endsWith('and')).toBe(true);
    expect(cut!.d).toMatchObject({ kind: 'interrupt', at: 'boundary', urge: { reason: 'contradiction' } });
  });

  it('treats a breath as a boundary', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    const base = 60_000;
    const w = ['the', 'grocery', 'budget', 'is', '600'];
    let d: Decision = { kind: 'listen' };
    w.forEach((_, i) => { d = l.hear({ text: w.slice(0, i + 1).join(' '), final: false, atMs: base + i * 200 }); });
    expect(d.kind).toBe('listen');
    // a 500ms pause, then the next word: that is where a person comes in
    d = l.hear({ text: 'the grocery budget is 600 for', final: false, atMs: base + 4 * 200 + 500 });
    expect(d).toMatchObject({ kind: 'interrupt', at: 'boundary' });
  });

  it('cuts in at once, boundary or not, when waiting would cost more than the rudeness', () => {
    const l = new Lines({ bluntness: 0 });
    l.hold('the trip fund', ['trip'], {
      position: "That's the trip money — you said it's not to be touched.",
      evidence: ['said on Monday'], confidence: 0.9, against: ['settle_up'],
    }, 0);
    const seq = say(l, 'send Sam four hundred from', 10_000, 250, { leader: 'settle_up', leaderRadius: 'external' });
    const cut = firstCut(seq)!;
    expect(cut.d).toMatchObject({ kind: 'interrupt', at: 'urgent', urge: { reason: 'against-stance' } });
    expect(cut.heard.text).toBe('send'); // the first word that routed there
  });

  it('keeps a point for the end of the turn when it is not worth cutting in for', () => {
    const l = new Lines();
    l.note({ kind: 'question', topic: 'the dentist', keys: ['dentist'], said: { text: 'when is the dentist', atMs: 0 } });
    const seq = say(l, 'I need to call the dentist tomorrow', 30_000);
    expect(seq.some((x) => x.d.kind === 'interrupt')).toBe(false);
    expect(seq[seq.length - 1]!.d).toMatchObject({ kind: 'queue', urge: { reason: 'return' } });
  });

  it('does not keep raising the same thing', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    expect(firstCut(say(l, 'the grocery budget is 600 and then', 60_000))).toBeDefined();
    expect(firstCut(say(l, 'the grocery budget is 600 and then', 70_000))).toBeUndefined();
  });

  it('never overwrites what you said with a contradiction before raising it', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    say(l, 'my grocery budget is 600', 60_000);
    expect(l.all[0]!.value).toBe(400);
    l.settle(l.all[0]!.id, 600, 'fine, 600 this month', 61_000);
    expect(l.all[0]!.value).toBe(600);
  });
});

describe('holding the floor', () => {
  const speaking = { leader: null, leaderRadius: null, speaking: true };

  it('keeps going through a nod', () => {
    const l = new Lines();
    for (const t of ['yeah', 'mm', 'uh-huh', 'right', 'okay sure']) {
      expect(l.hear({ text: t, final: false, atMs: 1 }, speaking)).toEqual({ kind: 'keep' });
    }
  });

  it('stops for a word that takes the turn, however short', () => {
    const l = new Lines();
    for (const t of ['wait', 'no', 'hold on', 'but', 'actually']) {
      expect(l.hear({ text: t, final: false, atMs: 1 }, speaking).kind).toBe('yield');
    }
  });

  it('stops when they start a real sentence', () => {
    const l = new Lines();
    expect(l.hear({ text: 'I think the', final: false, atMs: 1 }, speaking).kind).toBe('yield');
  });
});

describe('arguing', () => {
  function stance(bluntness = 0.5) {
    const l = new Lines({ bluntness });
    const t = l.hold('the trip fund', ['trip'], {
      position: "That's the trip money.", evidence: ['said on Monday'], confidence: 0.9, against: ['settle_up'],
    }, 0);
    return { l, t };
  }
  const paying = { leader: 'settle_up', leaderRadius: 'external' };

  it('yields to an override, and does not raise it again', () => {
    const { l, t } = stance();
    expect(firstCut(say(l, 'send Sam four hundred', 1000, 250, paying))).toBeDefined();
    expect(l.reply(t.id, 'I know, but do it anyway')).toBe('overridden');
    expect(firstCut(say(l, 'send Maya fifty', 100_000, 250, paying))).toBeUndefined();
  });

  it('is argued out of it by reasons, not by repetition', () => {
    const { l, t } = stance();
    expect(l.reply(t.id, 'because the trip got cancelled')).toBe('holding');
    expect(t.stance!.confidence).toBeCloseTo(0.55);
    expect(l.reply(t.id, 'actually I got the refund yesterday')).toBe('conceded');
    expect(t.stance!.evidence).toHaveLength(3);
  });

  it('takes agreement as agreement', () => {
    const { l, t } = stance();
    expect(l.reply(t.id, "you're right, don't do it")).toBe('agreed');
    expect(t.resolved).toBe(true);
  });

  it('argues once at default bluntness, and twice when turned up — never more', () => {
    const count = (b: number) => {
      const { l } = stance(b);
      let cuts = 0;
      for (let i = 0; i < 5; i++) {
        if (firstCut(say(l, 'send Sam four hundred', 1000 + i * 100_000, 250, paying))) cuts++;
      }
      return cuts;
    };
    expect(count(0.5)).toBe(1);
    expect(count(0.9)).toBe(2);
  });

  it('reopens an overridden point only on new evidence', () => {
    const { l, t } = stance();
    say(l, 'send Sam four hundred', 1000, 250, paying);
    l.reply(t.id, 'do it anyway');
    expect(l.reopen(t.id, 'the trip was rebooked for next month', 50_000)).toBe(true);
    expect(firstCut(say(l, 'send Sam four hundred', 60_000, 250, paying))).toBeDefined();
  });
});

describe('wandering', () => {
  it('goes back to something left open when it is quiet and nothing is on stage', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    expect(l.wander(3_000, false)).toBeNull(); // not quiet long enough
    expect(l.wander(10_000, true)).toBeNull(); // something is on stage
    const u = l.wander(10_000, false);
    expect(u).toMatchObject({ reason: 'return', thread: { topic: 'grocery budget' } });
  });

  it('does not wander twice in a row', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    say(l, 'my rent budget is 1450', 1_000);
    expect(l.wander(10_000, false)).not.toBeNull();
    expect(l.wander(11_000, false)).toBeNull();
  });

  it('lets old threads fade instead of dredging up everything ever said', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    expect(l.wander(3 * 60 * 60_000, false)).toBeNull(); // three hours on, it has faded
  });
});

describe('the harder debate cases', () => {
  it('picks a claim out of a French sentence, and cuts at a French joint', () => {
    const l = new Lines();
    say(l, 'mon budget courses est de 400', 0);
    expect(l.all[0]).toMatchObject({ kind: 'claim', topic: 'budget courses', value: 400 });
    const cut = firstCut(say(l, 'je pense que le budget courses va être de 650 et ça me va', 10_000));
    expect(cut?.heard.text).toBe('je pense que le budget courses va être de 650 et');
  });

  it('does not cut on the first word of a number that turns out to be the same one', () => {
    const l = new Lines();
    say(l, 'my grocery budget is 400', 0);
    expect(firstCut(say(l, 'the grocery budget is going to be four hundred like we said', 10_000))).toBeUndefined();
  });

  it('waits for a number said in words to finish before it compares', () => {
    const l = new Lines();
    say(l, 'my grocery budget is four hundred', 0);
    const cut = firstCut(say(l, 'I think the grocery budget is going to be six hundred and fifty and I am fine with that', 10_000));
    expect(cut?.heard.text).toMatch(/six hundred and fifty and$/);
  });
});
