import { describe, expect, it } from 'vitest';

import { spriteForCard } from '../src/office/sprites/cardSprite.js';

describe('spriteForCard', () => {
  it('returns the card sprite unchanged when it is loaded', () => {
    expect(spriteForCard(3, 22)).toEqual({ sheet: 3, hueShift: 0 });
    expect(spriteForCard(21, 22)).toEqual({ sheet: 21, hueShift: 0 });
    expect(spriteForCard(0, 6)).toEqual({ sheet: 0, hueShift: 0 });
  });

  it('falls back to a hue-shifted bundled sprite when the sheet is not loaded', () => {
    expect(spriteForCard(25, 22)).toEqual({ sheet: 25 % 6, hueShift: (25 * 47) % 360 });
    expect(spriteForCard(22, 22)).toEqual({ sheet: 22 % 6, hueShift: (22 * 47) % 360 });
  });

  it('is the same every time for the same index', () => {
    expect(spriteForCard(27, 6)).toEqual(spriteForCard(27, 6));
    expect(spriteForCard(27, 6)).toEqual(spriteForCard(27, 10));
  });

  it('only ever picks a bundled sheet and keeps the hue in range', () => {
    for (let i = 0; i < 60; i++) {
      const { sheet, hueShift } = spriteForCard(i, 6);
      expect(sheet).toBeGreaterThanOrEqual(0);
      expect(sheet).toBeLessThan(6);
      expect(hueShift).toBeGreaterThanOrEqual(0);
      expect(hueShift).toBeLessThan(360);
    }
  });

  it('treats a missing or invalid index as unloaded, never as a sheet', () => {
    expect(spriteForCard(-1, 22).sheet).toBeGreaterThanOrEqual(0);
    expect(spriteForCard(-1, 22).sheet).toBeLessThan(6);
  });
});
