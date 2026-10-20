import { describe, expect, it } from 'vitest';

import {
  formatCount,
  formatDuration,
  formatHours,
  formatStatus,
  formatTokens,
  formatXpLine,
  rosterKey,
  taskElapsedMs,
  xpFraction,
} from '../src/components/rosterFormat.js';

describe('formatXpLine', () => {
  it('shows progress and the distance to the next level', () => {
    expect(formatXpLine({ level: 27, xpIntoLevel: 640, xpToNext: 1000 })).toBe(
      '640 / 1000 XP · 360 to LV 28',
    );
  });

  it('rounds fractional XP so the line never shows decimals', () => {
    expect(formatXpLine({ level: 1, xpIntoLevel: 12.6, xpToNext: 100 })).toBe(
      '13 / 100 XP · 87 to LV 2',
    );
    expect(formatXpLine({ level: 1, xpIntoLevel: 0.2, xpToNext: 100 })).toBe(
      '0 / 100 XP · 100 to LV 2',
    );
  });

  it('never reports a negative remainder', () => {
    expect(formatXpLine({ level: 3, xpIntoLevel: 120, xpToNext: 100 })).toBe(
      '100 / 100 XP · 0 to LV 4',
    );
  });
});

describe('xpFraction', () => {
  it('is the filled share of the bar, clamped to 0..1', () => {
    expect(xpFraction({ level: 27, xpIntoLevel: 640, xpToNext: 1000 })).toBeCloseTo(0.64);
    expect(xpFraction({ level: 1, xpIntoLevel: 500, xpToNext: 100 })).toBe(1);
    expect(xpFraction({ level: 1, xpIntoLevel: -5, xpToNext: 100 })).toBe(0);
    expect(xpFraction({ level: 1, xpIntoLevel: 5, xpToNext: 0 })).toBe(0);
  });
});

describe('formatDuration', () => {
  it('shows minutes and seconds under an hour', () => {
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(760_000)).toBe('12m 40s');
  });

  it('shows only seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(9_400)).toBe('9s');
  });

  it('shows hours and zero-padded minutes from an hour up', () => {
    expect(formatDuration(3_780_000)).toBe('1h 03m');
    expect(formatDuration(7_200_000)).toBe('2h 00m');
  });

  it('treats negative or non-finite input as zero', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatTokens', () => {
  it('prints small counts as they are', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(842)).toBe('842');
  });

  it('abbreviates thousands to one decimal', () => {
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(48_200)).toBe('48.2k');
    expect(formatTokens(1_000)).toBe('1.0k');
  });

  it('abbreviates millions to one decimal', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('rolls over to M instead of printing 1000.0k', () => {
    expect(formatTokens(999_990)).toBe('1.0M');
  });
});

describe('formatHours', () => {
  it('converts seconds to hours with one decimal', () => {
    expect(formatHours(45_000)).toBe('12.5 h');
    expect(formatHours(0)).toBe('0.0 h');
    expect(formatHours(3_600)).toBe('1.0 h');
  });
});

describe('formatCount', () => {
  it('groups thousands and rounds', () => {
    expect(formatCount(1318)).toBe('1,318');
    expect(formatCount(7)).toBe('7');
    expect(formatCount(1234567.4)).toBe('1,234,567');
  });
});

describe('formatStatus', () => {
  it('names each status the way the user reads it', () => {
    expect(formatStatus('working')).toBe('working');
    expect(formatStatus('waiting')).toBe('waiting on you');
    expect(formatStatus('idle')).toBe('idle');
  });
});

describe('taskElapsedMs', () => {
  it('counts up from the start while the task runs', () => {
    expect(taskElapsedMs(1_000, null, 5_500)).toBe(4_500);
  });

  it('freezes at the end time once the task ended', () => {
    expect(taskElapsedMs(1_000, 3_000, 9_999)).toBe(2_000);
  });

  it('is null when no task has started', () => {
    expect(taskElapsedMs(null, null, 9_999)).toBeNull();
  });

  it('never goes negative when the clocks disagree', () => {
    expect(taskElapsedMs(10_000, null, 4_000)).toBe(0);
  });
});

describe('rosterKey', () => {
  it('is the agent id alone for a top-level agent or teammate', () => {
    expect(rosterKey(7)).toBe('7');
    expect(rosterKey(7, undefined)).toBe('7');
  });

  it('adds the tool id for a Task-tool sub-character', () => {
    expect(rosterKey(7, 'toolu_1')).toBe('7:toolu_1');
  });
});
