import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ActivityTracker,
  IDLE_CUTOFF_MS,
  MIN_SUBAGENT_TASK_MS,
} from '../src/roster/activityTracker.js';
import { RosterStore } from '../src/roster/rosterStore.js';
import { XP_PER_WORKING_SECOND } from '../src/roster/xp.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

let dir: string;
let store: RosterStore;
let cards: Record<string, string | null>;
let tracker: ActivityTracker;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-tracker-'));
  store = new RosterStore({
    filePath: path.join(dir, 'roster.json'),
    processId: 'test',
    log: () => {},
  });
  cards = { s1: 'card-a', s2: 'card-b', temp: null };
  tracker = new ActivityTracker(store, (id) => cards[id] ?? null);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Start a working session at t = 0 with activity at 0. */
function startWorking(id = 's1', t = 0): void {
  tracker.taskStart(id, t);
  tracker.status(id, 'working', t);
}

describe('ActivityTracker time and XP', () => {
  it('working for 60 s with activity earns 60 s and 12 xp', () => {
    startWorking();
    tracker.activity('s1', 30 * SEC);
    tracker.tick(60 * SEC);
    const s = store.get('card-a');
    expect(s.workedSeconds).toBeCloseTo(60, 6);
    expect(s.xp).toBeCloseTo(12, 6);
    expect(XP_PER_WORKING_SECOND).toBe(0.2);
  });

  it('waiting and idle earn nothing', () => {
    tracker.taskStart('s1', 0);
    tracker.status('s1', 'waiting', 0);
    tracker.activity('s1', 30 * SEC);
    tracker.tick(60 * SEC);
    tracker.status('s1', 'idle', 60 * SEC);
    tracker.activity('s1', 90 * SEC);
    tracker.tick(120 * SEC);
    expect(store.get('card-a').workedSeconds).toBe(0);
    expect(store.get('card-a').xp).toBe(0);
  });

  it('a status change to working does not retro-credit the time spent waiting', () => {
    tracker.status('s1', 'waiting', 0);
    tracker.tick(30 * SEC);
    tracker.status('s1', 'working', 100 * SEC);
    tracker.tick(110 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(10, 6);
  });

  it('working then waiting credits only the working stretch', () => {
    startWorking();
    tracker.status('s1', 'waiting', 40 * SEC);
    tracker.tick(100 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(40, 6);
  });

  it('accrual stops 5 min after last activity even if still working', () => {
    startWorking();
    for (let t = MIN; t <= 10 * MIN; t += MIN) tracker.tick(t);
    expect(IDLE_CUTOFF_MS).toBe(5 * MIN);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300, 6);
  });

  it('new activity after the cutoff resumes accrual from that moment', () => {
    startWorking();
    tracker.tick(10 * MIN);
    tracker.activity('s1', 10 * MIN);
    tracker.tick(10 * MIN + 20 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300 + 20, 6);
  });

  it('keeps fractional seconds across ticks', () => {
    startWorking();
    for (let i = 1; i <= 10; i++) tracker.tick(i * 100);
    const s = store.get('card-a');
    expect(s.workedSeconds).toBeCloseTo(1, 9);
    expect(s.xp).toBeCloseTo(0.2, 9);
  });

  it('sleep gap is capped and backwards clock adds nothing', () => {
    startWorking();
    tracker.tick(0);
    tracker.activity('s1', 0);
    tracker.tick(3 * HOUR);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300, 6);
    expect(store.get('card-a').xp).toBeCloseTo(60, 6);

    tracker.tick(2 * HOUR);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300, 6);

    // The backwards tick must not have moved lastTick back: a later tick credits nothing for the gap
    // already covered (activity is still stale), and new activity credits only from the real latest tick.
    tracker.tick(3 * HOUR + 10 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300, 6);
    tracker.activity('s1', 3 * HOUR + 10 * SEC);
    tracker.tick(3 * HOUR + 15 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(305, 6);
  });

  it('a backwards tick while accruing does not double-credit when the clock recovers', () => {
    startWorking();
    tracker.tick(60 * SEC);
    tracker.tick(30 * SEC);
    tracker.tick(60 * SEC);
    tracker.tick(70 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(70, 6);
  });

  it('a long gap bridged by an event is capped, not credited in full', () => {
    startWorking();
    tracker.activity('s1', 3 * HOUR);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300, 6);
  });

  it('removed stops accrual at once', () => {
    startWorking();
    tracker.removed('s1', 20 * SEC);
    tracker.tick(100 * SEC);
    tracker.tick(200 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(20, 6);
    expect(tracker.snapshot('s1').status).toBe('idle');
  });

  it('removed after a long silence is still capped', () => {
    startWorking();
    tracker.removed('s1', 2 * HOUR);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(300, 6);
  });

  it('each session credits its own card', () => {
    startWorking('s1');
    startWorking('s2');
    tracker.tick(10 * SEC);
    tracker.removed('s2', 10 * SEC);
    tracker.tick(20 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(20, 6);
    expect(store.get('card-b').workedSeconds).toBeCloseTo(10, 6);
  });

  it('looks up the card when writing, so a key that loses its card stops crediting', () => {
    startWorking();
    tracker.tick(10 * SEC);
    cards.s1 = null;
    tracker.tick(20 * SEC);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(10, 6);
    cards.s1 = 'card-b';
    tracker.tick(30 * SEC);
    expect(store.get('card-b').workedSeconds).toBeCloseTo(10, 6);
    expect(store.get('card-a').workedSeconds).toBeCloseTo(10, 6);
  });
});

describe('ActivityTracker tasks and tokens', () => {
  it('taskEnd counts one task; time on task freezes at end and resets at next start', () => {
    tracker.taskStart('s1', 1000);
    expect(tracker.snapshot('s1')).toMatchObject({ taskStartedAt: 1000, taskEndedAt: null });
    tracker.taskEnd('s1', 5000);
    expect(store.get('card-a').tasksCompleted).toBe(1);
    expect(tracker.snapshot('s1')).toMatchObject({ taskStartedAt: 1000, taskEndedAt: 5000 });

    tracker.tick(9000);
    expect(tracker.snapshot('s1')).toMatchObject({ taskStartedAt: 1000, taskEndedAt: 5000 });

    tracker.taskStart('s1', 20_000);
    expect(tracker.snapshot('s1')).toMatchObject({ taskStartedAt: 20_000, taskEndedAt: null });
    expect(store.get('card-a').tasksCompleted).toBe(1);
  });

  it('taskEnd without an open task counts nothing and changes nothing', () => {
    tracker.taskEnd('s1', 1000);
    expect(store.get('card-a').tasksCompleted).toBe(0);
    expect(tracker.snapshot('s1')).toMatchObject({ taskStartedAt: null, taskEndedAt: null });

    tracker.taskStart('s1', 2000);
    tracker.taskEnd('s1', 3000);
    tracker.taskEnd('s1', 4000);
    expect(store.get('card-a').tasksCompleted).toBe(1);
    expect(tracker.snapshot('s1').taskEndedAt).toBe(3000);
  });

  it('taskStart while a task is open restarts it without counting the unfinished one', () => {
    tracker.taskStart('s1', 1000);
    tracker.taskStart('s1', 2000);
    expect(store.get('card-a').tasksCompleted).toBe(0);
    tracker.taskEnd('s1', 3000);
    expect(store.get('card-a').tasksCompleted).toBe(1);
    expect(tracker.snapshot('s1').taskStartedAt).toBe(2000);
  });

  it('tokens add to the task and to lifetime; the task total resets at taskStart', () => {
    tracker.taskStart('s1', 0);
    tracker.tokens('s1', 100);
    tracker.tokens('s1', 0);
    tracker.tokens('s1', 50);
    expect(tracker.snapshot('s1').taskTokens).toBe(150);
    expect(store.get('card-a').lifetimeTokens).toBe(150);

    tracker.taskEnd('s1', 1000);
    expect(tracker.snapshot('s1').taskTokens).toBe(150);

    tracker.taskStart('s1', 2000);
    expect(tracker.snapshot('s1').taskTokens).toBe(0);
    tracker.tokens('s1', 25);
    expect(tracker.snapshot('s1').taskTokens).toBe(25);
    expect(store.get('card-a').lifetimeTokens).toBe(175);
  });

  it('ignores negative and non-finite token counts', () => {
    tracker.tokens('s1', -5);
    tracker.tokens('s1', Number.NaN);
    tracker.tokens('s1', Number.POSITIVE_INFINITY);
    expect(tracker.snapshot('s1').taskTokens).toBe(0);
    expect(store.get('card-a').lifetimeTokens).toBe(0);
  });

  it('subagent under 10 s earns no task; 10 s or more earns one', () => {
    expect(MIN_SUBAGENT_TASK_MS).toBe(10_000);
    tracker.subagentEnded('s1', 0, 9_999);
    expect(store.get('card-a').tasksCompleted).toBe(0);
    tracker.subagentEnded('s1', 0, 10_000);
    expect(store.get('card-a').tasksCompleted).toBe(1);
    tracker.subagentEnded('s2', 5_000, 65_000);
    expect(store.get('card-b').tasksCompleted).toBe(1);
    expect(store.get('card-a').tasksCompleted).toBe(1);
  });

  it('a subagent whose end precedes its start earns nothing', () => {
    tracker.subagentEnded('s1', 20_000, 5_000);
    expect(store.get('card-a').tasksCompleted).toBe(0);
  });
});

describe('ActivityTracker temps and unknown sessions', () => {
  it('temp agent writes no deltas but has a snapshot', () => {
    tracker.taskStart('temp', 0);
    tracker.status('temp', 'working', 0);
    tracker.tokens('temp', 40);
    tracker.tick(60 * SEC);
    tracker.subagentEnded('temp', 0, 60 * SEC);
    tracker.taskEnd('temp', 60 * SEC);
    expect(tracker.snapshot('temp')).toEqual({
      status: 'working',
      taskStartedAt: 0,
      taskEndedAt: 60 * SEC,
      taskTokens: 40,
    });
    for (const id of ['card-a', 'card-b', 'temp', '']) {
      expect(store.get(id)).toMatchObject({
        xp: 0,
        workedSeconds: 0,
        tasksCompleted: 0,
        lifetimeTokens: 0,
      });
    }
  });

  it('snapshot of an unknown session is an empty snapshot', () => {
    expect(tracker.snapshot('nope')).toEqual({
      status: 'idle',
      taskStartedAt: null,
      taskEndedAt: null,
      taskTokens: 0,
    });
  });

  it('treats session keys as opaque strings', () => {
    cards['abc#tool-1'] = 'card-b';
    tracker.taskStart('abc#tool-1', 0);
    tracker.status('abc#tool-1', 'working', 0);
    tracker.tick(10 * SEC);
    expect(store.get('card-b').workedSeconds).toBeCloseTo(10, 6);
  });
});
