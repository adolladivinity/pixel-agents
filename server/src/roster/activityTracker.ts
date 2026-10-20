import type { RosterStore } from './rosterStore.js';
import { XP_PER_WORKING_SECOND } from './xp.js';

/** A working card stops earning time and XP this long after its last activity. */
export const IDLE_CUTOFF_MS = 5 * 60_000;
/** A subagent run shorter than this earns no task count. */
export const MIN_SUBAGENT_TASK_MS = 10_000;

export type TrackedStatus = 'working' | 'waiting' | 'idle';

export interface ActivitySnapshot {
  status: TrackedStatus;
  taskStartedAt: number | null;
  taskEndedAt: number | null;
  taskTokens: number;
}

interface SessionState {
  status: TrackedStatus;
  /** Time up to which accrual has already been settled. Never moves backwards. */
  lastTick: number | null;
  /** Latest event time seen; accrual is capped at this plus IDLE_CUTOFF_MS. Never moves backwards. */
  lastActivity: number | null;
  taskStartedAt: number | null;
  taskEndedAt: number | null;
  taskOpen: boolean;
  taskTokens: number;
}

function newState(): SessionState {
  return {
    status: 'idle',
    lastTick: null,
    lastActivity: null,
    taskStartedAt: null,
    taskEndedAt: null,
    taskOpen: false,
    taskTokens: 0,
  };
}

/**
 * Turns task, status, activity and token events into stats deltas on the card each session
 * currently holds. Pure bookkeeping: it has no clock and no timers. Every method that takes a
 * time `t` uses only that value, and the owner calls `tick(t)` regularly (a few seconds apart)
 * to bank working time.
 *
 * Session keys are opaque strings (a session id, or `${sessionId}#tool-${toolId}` for a Task-tool
 * subagent). `cardIdFor` is asked every time a delta is written, never cached: a key whose card
 * changes or becomes null (a Temp) stops crediting the old card at once. Temps still keep
 * snapshot state, they just write nothing.
 *
 * Time accrual rule. Time is banked by "settling" a session up to `t` before anything else
 * happens at `t`, so the status in force during the interval is the one that earns:
 *
 *   credit = max(0, min(t, lastActivity + IDLE_CUTOFF_MS) - lastTick)   only while status is working
 *
 * `lastTick` then moves to max(lastTick, t). Consequences: a sleep or clock jump forward adds at
 * most the time up to the idle cutoff; a clock that runs backwards adds nothing and leaves
 * `lastTick` where it was (so it can't be paid twice when the clock recovers); a change to
 * 'working' starts its interval at the change, never at an earlier tick, so waiting and idle
 * time is never paid retroactively.
 *
 * What counts as activity: every event carrying a time (task start/end, status change,
 * `activity`). `tokens` has no time, so the caller should also call `activity` for the JSONL
 * line that produced the tokens.
 */
export class ActivityTracker {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly store: RosterStore,
    private readonly cardIdFor: (sessionId: string) => string | null,
  ) {}

  taskStart(sessionId: string, t: number): void {
    const s = this.touch(sessionId, t);
    // A start while a task is still open (its Stop was missed) restarts it; the old one is not counted.
    s.taskStartedAt = t;
    s.taskEndedAt = null;
    s.taskOpen = true;
    s.taskTokens = 0;
  }

  taskEnd(sessionId: string, t: number): void {
    const s = this.touch(sessionId, t);
    // Tasks completed counts finished turns: an end with no open task finished nothing.
    if (!s.taskOpen) return;
    s.taskOpen = false;
    s.taskEndedAt = Math.max(t, s.taskStartedAt ?? t);
    this.write(sessionId, { tasksCompleted: 1 });
  }

  activity(sessionId: string, t: number): void {
    this.touch(sessionId, t);
  }

  status(sessionId: string, status: TrackedStatus, t: number): void {
    const s = this.touch(sessionId, t);
    s.status = status;
  }

  /** Add `n` tokens to the current task and to the card's lifetime total. */
  tokens(sessionId: string, n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.state(sessionId).taskTokens += n;
    this.write(sessionId, { lifetimeTokens: n });
  }

  /** Credit time up to `t` and forget the session. Nothing accrues afterwards. */
  removed(sessionId: string, t: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.settle(sessionId, s, t);
    this.sessions.delete(sessionId);
  }

  tick(t: number): void {
    for (const [id, s] of this.sessions) this.settle(id, s, t);
  }

  /** A subagent's whole run is one task on its own card, if it lasted long enough. */
  subagentEnded(sessionId: string, startedAt: number, endedAt: number): void {
    if (endedAt - startedAt < MIN_SUBAGENT_TASK_MS) return;
    this.write(sessionId, { tasksCompleted: 1 });
  }

  snapshot(sessionId: string): ActivitySnapshot {
    const s = this.sessions.get(sessionId);
    if (!s) return { status: 'idle', taskStartedAt: null, taskEndedAt: null, taskTokens: 0 };
    return {
      status: s.status,
      taskStartedAt: s.taskStartedAt,
      taskEndedAt: s.taskEndedAt,
      taskTokens: s.taskTokens,
    };
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = newState();
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Settle the session up to `t` under its current status, then record `t` as activity. */
  private touch(sessionId: string, t: number): SessionState {
    const s = this.state(sessionId);
    this.settle(sessionId, s, t);
    if (Number.isFinite(t))
      s.lastActivity = s.lastActivity === null ? t : Math.max(s.lastActivity, t);
    return s;
  }

  private settle(sessionId: string, s: SessionState, t: number): void {
    if (!Number.isFinite(t)) return;
    if (s.lastTick === null) {
      s.lastTick = t;
      return;
    }
    if (s.status === 'working' && s.lastActivity !== null) {
      const until = Math.min(t, s.lastActivity + IDLE_CUTOFF_MS);
      const ms = until - s.lastTick;
      if (ms > 0) {
        const seconds = ms / 1000;
        this.write(sessionId, { workedSeconds: seconds, xp: seconds * XP_PER_WORKING_SECOND });
      }
    }
    s.lastTick = Math.max(s.lastTick, t);
  }

  private write(sessionId: string, delta: Parameters<RosterStore['addDelta']>[1]): void {
    const cardId = this.cardIdFor(sessionId);
    if (cardId !== null) this.store.addDelta(cardId, delta);
  }
}
