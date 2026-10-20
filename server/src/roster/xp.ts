/** XP earned per second a card is working. 0.2/s means level 2 (100 XP) takes about 8 working minutes. */
export const XP_PER_WORKING_SECOND = 0.2;

/** XP needed to go from `level` to `level + 1`. Grows as level^1.5, so early levels are quick. */
export function xpToNext(level: number): number {
  return Math.round(100 * level ** 1.5);
}

/**
 * Turn lifetime XP into a level (starting at 1), the XP earned inside that level,
 * and the XP that level needs in total. Negative, NaN or non-finite xp counts as 0.
 */
export function levelInfo(xp: number): { level: number; xpIntoLevel: number; xpToNext: number } {
  let remaining = Number.isFinite(xp) && xp > 0 ? xp : 0;
  let level = 1;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpToNext: xpToNext(level) };
}
