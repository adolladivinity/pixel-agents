/**
 * Pure formatters for the roster panel. The server sends raw numbers (see
 * `AgentRoster` in core/src/messages.ts); everything the user reads is made
 * here, so it can be tested without a DOM.
 */
import type { RosterLevel, RosterStatus } from '../../../core/src/messages.js';

/** Whole, non-negative number. XP can be fractional (it accrues per second). */
function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** "640 / 1000 XP · 360 to LV 28" */
export function formatXpLine(level: RosterLevel): string {
  const span = whole(level.xpToNext);
  const into = Math.min(whole(level.xpIntoLevel), span);
  const remaining = Math.max(0, whole(level.xpToNext - level.xpIntoLevel));
  return `${into} / ${span} XP · ${remaining} to LV ${level.level + 1}`;
}

/** Filled share of the XP bar, 0..1. */
export function xpFraction(level: RosterLevel): number {
  if (!(level.xpToNext > 0)) return 0;
  return Math.min(1, Math.max(0, level.xpIntoLevel / level.xpToNext));
}

/** "4m 12s", "1h 03m"; under a minute just "9s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "842", "12.4k", "1.2M". */
export function formatTokens(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (value < 1000) return String(Math.round(value));
  const thousands = (value / 1000).toFixed(1);
  // 999_990 would print "1000.0k"; that is "1.0M".
  if (value < 1_000_000 && thousands !== '1000.0') return `${thousands}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** "12.5 h" from seconds. */
export function formatHours(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${(value / 3600).toFixed(1)} h`;
}

/** "1,318" */
export function formatCount(n: number): string {
  return whole(n).toLocaleString('en-US');
}

const STATUS_TEXT: Record<RosterStatus, string> = {
  working: 'working',
  waiting: 'waiting on you',
  idle: 'idle',
};

export function formatStatus(status: RosterStatus): string {
  return STATUS_TEXT[status] ?? 'idle';
}

/**
 * Time on this task: counts up from `startedAt`, freezes at `endedAt`.
 * Null when no task has started. Never negative if the clocks disagree.
 */
export function taskElapsedMs(
  startedAt: number | null,
  endedAt: number | null,
  now: number,
): number | null {
  if (startedAt === null) return null;
  return Math.max(0, (endedAt ?? now) - startedAt);
}

/**
 * Key an `agentRoster` message is stored under. A top-level agent or teammate
 * is its id; a Task-tool sub-character is its parent's id plus the tool id,
 * the same pair `OfficeState.getSubagentId` takes.
 */
export function rosterKey(agentId: number, parentToolId?: string): string {
  return parentToolId ? `${agentId}:${parentToolId}` : String(agentId);
}
