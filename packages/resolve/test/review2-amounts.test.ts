/**
 * Review 2: amounts that resolveQuantity CONFIRMS (score 1, calibrated) at a
 * value the speaker did not say. A confirmed quantity is not provisional, so
 * nothing downstream asks again; on a payment card it is the pre-filled
 * amount the person is asked to say yes to.
 */
import { describe, expect, it } from 'vitest';
import { resolveQuantity } from '../src/index.js';

/** What was confirmed, if anything: [n, score] for the top candidate when it would confirm. */
const confirmed = (t: string) => {
  const c = resolveQuantity(t);
  const top = c[0];
  if (!top || top.score < 0.85 || top.calibrated === false) return null;
  if (c[1] && top.score - c[1].score < 0.15) return null;
  return (top.value as { n: number }).n;
};

describe('review2: a confirmed amount must be the amount said, or nothing', () => {
  it('"$1,500" (thousands separator) is not confirmed as $1.50', () => {
    expect([1500, null]).toContain(confirmed('pay Maya $1,500'));
  });
  it('"1,500 dollars" is not confirmed as $0', () => {
    expect([1500, null]).toContain(confirmed('pay Maya 1,500 dollars'));
  });
  it('"1.500 euros" (European thousands) is not confirmed as 0', () => {
    expect([1500, null]).toContain(confirmed('rembourser Sam 1.500 euros'));
  });
  it('"fifty cents" is not confirmed as 5000', () => {
    expect([0.5, null]).toContain(confirmed('pay Maya fifty cents'));
  });
  it('"two million dollars" is not confirmed as 2', () => {
    expect([2_000_000, null]).toContain(confirmed('pay Sam two million dollars'));
  });
  it('"$20k" is not confirmed as $20', () => {
    expect([20_000, null]).toContain(confirmed('pay Sam $20k'));
  });
  it('"$5.999" is not confirmed as $5.99', () => {
    expect([5.999, null]).toContain(confirmed('pay Sam $5.999'));
  });
});
