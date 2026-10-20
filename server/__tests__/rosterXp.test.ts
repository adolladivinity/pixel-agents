import { describe, expect, it } from 'vitest';

import { levelInfo, XP_PER_WORKING_SECOND, xpToNext } from '../src/roster/xp.js';

describe('roster xp', () => {
  it('level 1 at 0 xp', () => {
    expect(levelInfo(0)).toEqual({ level: 1, xpIntoLevel: 0, xpToNext: 100 });
  });

  it('level 2 at exactly 100 xp', () => {
    expect(levelInfo(100)).toEqual({ level: 2, xpIntoLevel: 0, xpToNext: xpToNext(2) });
  });

  it('stays level 1 one xp short of level 2', () => {
    expect(levelInfo(99)).toEqual({ level: 1, xpIntoLevel: 99, xpToNext: 100 });
  });

  it('reports progress inside a level', () => {
    const info = levelInfo(100 + 50);
    expect(info.level).toBe(2);
    expect(info.xpIntoLevel).toBe(50);
    expect(info.xpToNext).toBe(Math.round(100 * 2 ** 1.5));
  });

  it('xpToNext follows 100 * level^1.5, rounded', () => {
    expect(xpToNext(1)).toBe(100);
    expect(xpToNext(4)).toBe(800);
    expect(xpToNext(2)).toBe(283);
  });

  it('level 2 within one working hour', () => {
    expect(levelInfo(3600 * XP_PER_WORKING_SECOND).level).toBeGreaterThanOrEqual(2);
  });

  it('around level 10 after 15 working hours', () => {
    const l = levelInfo(15 * 3600 * XP_PER_WORKING_SECOND).level;
    expect(l).toBeGreaterThanOrEqual(9);
    expect(l).toBeLessThanOrEqual(11);
  });

  it('level is monotonic in xp', () => {
    let prev = 1;
    for (let xp = 0; xp < 500_000; xp += 997) {
      const l = levelInfo(xp).level;
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });

  it('treats negative, NaN and non-finite xp as 0', () => {
    const zero = { level: 1, xpIntoLevel: 0, xpToNext: 100 };
    expect(levelInfo(-5)).toEqual(zero);
    expect(levelInfo(Number.NaN)).toEqual(zero);
    expect(levelInfo(Number.POSITIVE_INFINITY)).toEqual(zero);
    expect(levelInfo(Number.NEGATIVE_INFINITY)).toEqual(zero);
  });
});
