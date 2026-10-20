import { PALETTE_COUNT } from '../../constants.js';

/** Hue step per card index (degrees), so neighbouring missing sprites get clearly different tints. */
const FALLBACK_HUE_STEP_DEG = 47;

export interface CardSprite {
  /** Index into the combined character list (bundled sheets first, then external asset dirs). */
  sheet: number;
  /** Hue shift in degrees to apply to that sheet; 0 for a card's own sprite. */
  hueShift: number;
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * Which sheet and hue a roster card is drawn with.
 *
 * A card names its sprite by position in the combined character list. When that
 * sheet is loaded it is used as is. When it is not (an asset directory was not
 * added, or holds fewer sheets), the card falls back to a bundled sheet with a
 * hue shift derived from the index alone, so the same card looks the same on
 * every run and every client, and neighbouring cards do not look alike.
 */
export function spriteForCard(spriteIndex: number, loadedCount: number): CardSprite {
  if (Number.isInteger(spriteIndex) && spriteIndex >= 0 && spriteIndex < loadedCount) {
    return { sheet: spriteIndex, hueShift: 0 };
  }
  const index = Number.isInteger(spriteIndex) ? spriteIndex : 0;
  return {
    sheet: mod(index, PALETTE_COUNT),
    hueShift: mod(index * FALLBACK_HUE_STEP_DEG, 360),
  };
}

/** Temp hue range: never 0 (a loaded card sheet always has hue 0), never under 45 degrees. */
const TEMP_HUE_MIN_DEG = 45;
const TEMP_HUE_RANGE_DEG = 271; // prime, so seeds a multiple of 6 apart rarely collide
const TEMP_HUE_STEP = 61;

/**
 * The look of a Temp (pool exhausted, no card): a bundled sheet with a non-zero
 * hue shift, a pure function of `seed` (the agent id) so it is stable across
 * messages and clients, and different for different agents. A card's own look
 * for a loaded sheet always has hue 0, so a Temp can never be mistaken for one.
 */
export function spriteForTemp(seed: number): CardSprite {
  const s = Number.isInteger(seed) ? seed : 0;
  return {
    sheet: mod(s, PALETTE_COUNT),
    hueShift: TEMP_HUE_MIN_DEG + mod(s * TEMP_HUE_STEP, TEMP_HUE_RANGE_DEG),
  };
}
