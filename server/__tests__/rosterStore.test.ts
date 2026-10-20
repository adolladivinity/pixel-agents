import * as fs from 'fs';
import fsDefault from 'fs';
import { syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RosterStore } from '../src/roster/rosterStore.js';

let dir: string;
let file: string;
let warnings: string[];

function store(processId: string, now?: () => number, extra: { lockTimeoutMs?: number } = {}) {
  return new RosterStore({
    filePath: file,
    processId,
    now,
    log: (m) => warnings.push(m),
    ...extra,
  });
}

function corruptCopies(): string[] {
  return fs.readdirSync(dir).filter((f) => f.startsWith('roster.json.corrupt-'));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-store-'));
  file = path.join(dir, 'roster.json');
  warnings = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('RosterStore stats', () => {
  it('two stores on one file both keep their deltas', () => {
    const a = store('A');
    const b = store('B');
    a.addDelta('x', { xp: 5 });
    b.addDelta('x', { xp: 7 });
    a.flush();
    b.flush();
    expect(store('C').get('x').xp).toBe(12);
  });

  it('stats survive a new instance', () => {
    const a = store('A', () => Date.parse('2026-10-18T10:00:00Z'));
    a.addDelta('x', { xp: 4, workedSeconds: 20, tasksCompleted: 1, lifetimeTokens: 900 });
    a.flush();
    expect(store('B').get('x')).toEqual({
      xp: 4,
      workedSeconds: 20,
      tasksCompleted: 1,
      lifetimeTokens: 900,
      firstSeen: '2026-10-18T10:00:00.000Z',
      lastSeen: '2026-10-18T10:00:00.000Z',
    });
  });

  it('get includes unflushed deltas and zeros for an unseen card', () => {
    const a = store('A');
    expect(a.get('nobody')).toMatchObject({ xp: 0, workedSeconds: 0, tasksCompleted: 0 });
    a.addDelta('x', { xp: 3 });
    a.addDelta('x', { xp: 2 });
    expect(a.get('x').xp).toBe(5);
    a.flush();
    expect(a.get('x').xp).toBe(5);
    a.flush();
    expect(store('B').get('x').xp).toBe(5);
  });

  it('negative delta is ignored', () => {
    const a = store('A');
    a.addDelta('x', { xp: -3 });
    expect(a.get('x').xp).toBe(0);
    a.addDelta('x', { xp: 5 });
    a.addDelta('x', { xp: -3, workedSeconds: Number.NaN });
    expect(a.get('x').xp).toBe(5);
    expect(a.get('x').workedSeconds).toBe(0);
  });

  it('creates a missing file and parent directory on first flush', () => {
    file = path.join(dir, 'nested', 'deeper', 'roster.json');
    const a = store('A');
    expect(a.readOnly).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    a.addDelta('x', { xp: 1 });
    a.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
    expect(fs.existsSync(file + '.lock')).toBe(false);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('unknown card ids in the file are preserved', () => {
    const removed = {
      xp: 99,
      workedSeconds: 10,
      tasksCompleted: 2,
      lifetimeTokens: 5,
      firstSeen: 'a',
      lastSeen: 'b',
    };
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, cards: { 'removed-card': removed }, inUse: {} }),
    );
    const a = store('A');
    a.addDelta('other', { xp: 1 });
    a.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.cards['removed-card']).toEqual(removed);
    expect(saved.cards.other.xp).toBe(1);
    expect(a.readOnly).toBe(false);
  });
});

describe('RosterStore claims', () => {
  it('claim blocks a second process', () => {
    const a = store('A');
    const b = store('B');
    expect(a.tryClaim('x', 'session-1')).toBe(true);
    expect(b.tryClaim('x', 'session-2')).toBe(false);
    expect(b.claimedByOthers().has('x')).toBe(true);
    expect(a.claimedByOthers().has('x')).toBe(false);
  });

  it('the same process dedupes a claim from another agent but accepts the same agent', () => {
    const a = store('A');
    expect(a.tryClaim('x', 'session-1')).toBe(true);
    expect(a.tryClaim('x', 'session-1')).toBe(true);
    expect(a.tryClaim('x', 'session-2')).toBe(false);
  });

  it('stale claim is released after 60 s', () => {
    const a = store('A', () => 0);
    expect(a.tryClaim('x', 's1')).toBe(true);
    const b = store('B', () => 61_000);
    expect(b.claimedByOthers().has('x')).toBe(false);
    expect(b.tryClaim('x', 's2')).toBe(true);
  });

  it('a claim just under 60 s old still blocks', () => {
    const a = store('A', () => 0);
    a.tryClaim('x', 's1');
    expect(store('B', () => 59_000).tryClaim('x', 's2')).toBe(false);
  });

  it('heartbeat keeps a claim alive', () => {
    let t = 0;
    const a = store('A', () => t);
    a.tryClaim('x', 's1');
    t = 50_000;
    a.heartbeat();
    expect(store('B', () => 61_000).tryClaim('x', 's2')).toBe(false);
  });

  it('heartbeat refreshes every claim this process owns', () => {
    let t = 0;
    const a = store('A', () => t);
    a.tryClaim('x', 's1');
    a.tryClaim('y', 's2');
    t = 50_000;
    a.heartbeat();
    const b = store('B', () => 61_000);
    expect(b.tryClaim('x', 's3')).toBe(false);
    expect(b.tryClaim('y', 's4')).toBe(false);
  });

  it('release frees a claim, but only one this process owns', () => {
    const a = store('A');
    const b = store('B');
    a.tryClaim('x', 's1');
    b.release('x');
    expect(b.tryClaim('x', 's2')).toBe(false);
    a.release('x');
    expect(b.tryClaim('x', 's2')).toBe(true);
  });

  it('claims leave the cards untouched', () => {
    const a = store('A');
    a.addDelta('x', { xp: 3 });
    a.flush();
    a.tryClaim('x', 's1');
    a.heartbeat();
    a.release('x');
    expect(store('B').get('x').xp).toBe(3);
  });
});

describe('RosterStore locking', () => {
  it('stale lock file is removed', () => {
    const lock = file + '.lock';
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(lock, old, old);
    const a = store('A');
    a.addDelta('x', { xp: 2 });
    a.flush();
    expect(store('B').get('x').xp).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a held lock keeps the deltas for next time and warns instead of throwing', () => {
    const lock = file + '.lock';
    fs.writeFileSync(lock, '');
    const a = store('A', undefined, { lockTimeoutMs: 150 });
    a.addDelta('x', { xp: 2 });
    expect(() => a.flush()).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
    expect(a.tryClaim('x', 's1')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(lock);
    a.flush();
    expect(store('B').get('x').xp).toBe(2);
  });
});

describe('RosterStore lock and read failures', () => {
  it('an unremovable stale lock (a directory) times out instead of spinning', () => {
    const lock = file + '.lock';
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const a = store('A', undefined, { lockTimeoutMs: 200 });
    a.addDelta('x', { xp: 2 });
    const started = Date.now();
    a.flush();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warnings.some((w) => w.includes('could not lock'))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(a.get('x').xp).toBe(2);
    fs.rmSync(lock, { recursive: true });
    a.flush();
    expect(store('B').get('x').xp).toBe(2);
  });

  it('a transient read error is retried and does not corrupt or lock the store', () => {
    const seed = store('S');
    seed.addDelta('x', { xp: 3 });
    seed.flush();
    const real = fs.readFileSync;
    let failures = 1;
    const spy = vi.spyOn(fsDefault, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try {
      const a = store('A');
      expect(failures).toBeLessThan(0); // first read threw, a retry succeeded
      expect(a.readOnly).toBe(false);
      expect(a.get('x').xp).toBe(3);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(corruptCopies()).toHaveLength(0);
  });

  it('a persistently unreadable file is not corrupt: no backup, not read-only, retried later', () => {
    fs.mkdirSync(file); // reading a directory fails with EISDIR, a non-ENOENT error
    const a = store('A');
    expect(a.readOnly).toBe(false);
    a.addDelta('x', { xp: 4 });
    expect(() => a.flush()).not.toThrow();
    expect(a.tryClaim('x', 's1')).toBe(false);
    expect(a.claimedByOthers().size).toBe(0);
    expect(a.readOnly).toBe(false);
    expect(a.get('x').xp).toBe(4);
    expect(warnings.length).toBeGreaterThan(0);
    expect(corruptCopies()).toHaveLength(0);
    expect(fs.existsSync(file + '.lock')).toBe(false);
    fs.rmdirSync(file);
    a.flush();
    expect(store('B').get('x').xp).toBe(4);
    expect(a.tryClaim('x', 's1')).toBe(true);
  });
});

describe('RosterStore corrupt file', () => {
  const BAD = '{"version":1,"cards":{';

  it('corrupt file is backed up and never overwritten', () => {
    fs.writeFileSync(file, BAD);
    const a = store('A');
    expect(a.readOnly).toBe(true);
    const copies = corruptCopies();
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, copies[0]), 'utf8')).toBe(BAD);
    expect(warnings.length).toBeGreaterThan(0);
    a.addDelta('x', { xp: 5 });
    a.flush();
    expect(fs.readFileSync(file, 'utf8')).toBe(BAD);
    expect(fs.existsSync(file + '.lock')).toBe(false);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    expect(a.get('x').xp).toBe(5);
  });

  it('read-only store dedupes claims in memory and writes nothing', () => {
    fs.writeFileSync(file, BAD);
    const a = store('A');
    expect(a.tryClaim('x', 's1')).toBe(true);
    expect(a.tryClaim('x', 's2')).toBe(false);
    a.heartbeat();
    expect(a.claimedByOthers().size).toBe(0);
    a.release('x');
    expect(a.tryClaim('x', 's2')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(BAD);
    expect(fs.readdirSync(dir).sort()).toEqual(['roster.json', ...corruptCopies()].sort());
  });

  it.each([
    ['wrong version', { version: 2, cards: {}, inUse: {} }],
    ['cards not an object', { version: 1, cards: [], inUse: {} }],
    ['inUse missing', { version: 1, cards: {} }],
    ['negative stat', { version: 1, cards: { x: { xp: -1 } }, inUse: {} }],
    ['out-of-range stat', { version: 1, cards: { x: { xp: 1e13 } }, inUse: {} }],
    ['non-numeric stat', { version: 1, cards: { x: { lifetimeTokens: '5' } }, inUse: {} }],
  ])('invalid shape is corrupt: %s', (_name, content) => {
    const text = JSON.stringify(content);
    fs.writeFileSync(file, text);
    const a = store('A');
    expect(a.readOnly).toBe(true);
    a.addDelta('y', { xp: 1 });
    a.flush();
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(corruptCopies()).toHaveLength(1);
  });

  it('a file that breaks mid-session turns the store read-only without overwriting it', () => {
    const a = store('A');
    a.addDelta('x', { xp: 1 });
    a.flush();
    fs.writeFileSync(file, BAD);
    a.addDelta('x', { xp: 4 });
    a.flush();
    expect(a.readOnly).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(BAD);
    expect(corruptCopies()).toHaveLength(1);
    expect(a.get('x').xp).toBe(5);
    expect(a.tryClaim('y', 's1')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(BAD);
  });
});

describe('RosterStore durability and backup', () => {
  const BAD = '{"version":1,"cards":{';

  it('fsyncs the temp file before renaming it over roster.json', () => {
    const order: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    const s1 = vi.spyOn(fsDefault, 'fsyncSync').mockImplementation(((fd: number) => {
      order.push('fsync');
      return realFsync(fd);
    }) as typeof fs.fsyncSync);
    const s2 = vi.spyOn(fsDefault, 'renameSync').mockImplementation(((a: string, b: string) => {
      order.push(`rename:${path.basename(b)}`);
      return realRename(a, b);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    try {
      const a = store('A');
      a.addDelta('x', { xp: 1 });
      a.flush();
    } finally {
      s1.mockRestore();
      s2.mockRestore();
      syncBuiltinESMExports();
    }
    const rosterRename = order.indexOf('rename:roster.json');
    expect(rosterRename).toBeGreaterThan(-1);
    expect(order.slice(0, rosterRename)).toContain('fsync');
  });

  it('a normal flush keeps the previous good file as roster.json.bak', () => {
    const a = store('A');
    a.addDelta('x', { xp: 2 });
    a.flush();
    a.addDelta('x', { xp: 3 });
    a.flush();
    const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    expect(bak.version).toBe(1);
    expect(bak.cards.x.xp).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cards.x.xp).toBe(5);
    expect(fs.existsSync(file + '.bak.tmp')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['truncated', BAD],
  ])('%s roster.json with a valid .bak is restored and stays writable', (_n, bad) => {
    const seed = store('S');
    seed.addDelta('x', { xp: 7, tasksCompleted: 2 });
    seed.flush();
    seed.addDelta('x', { xp: 1 });
    seed.flush(); // .bak now holds a valid file with x.xp >= 7
    fs.writeFileSync(file, bad);
    const a = store('A');
    expect(a.readOnly).toBe(false);
    expect(a.get('x').xp).toBe(7);
    expect(a.get('x').tasksCompleted).toBe(2);
    expect(warnings.some((w) => /restor/i.test(w))).toBe(true);
    expect(corruptCopies()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, corruptCopies()[0]), 'utf8')).toBe(bad);
    a.addDelta('x', { xp: 3 });
    a.flush();
    expect(a.readOnly).toBe(false);
    expect(store('B').get('x').xp).toBe(10);
    expect(corruptCopies()).toHaveLength(1);
    // restoring never replaced the good backup with the bad file
    expect(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).cards.x.xp).toBeGreaterThanOrEqual(7);
  });

  it('a claim on a restored store is written back to a valid roster.json', () => {
    const seed = store('S');
    seed.addDelta('x', { xp: 7 });
    seed.flush();
    seed.flush();
    seed.tryClaim('y', 's0'); // second write so .bak exists
    fs.writeFileSync(file, '');
    const a = store('A');
    expect(a.tryClaim('z', 's1')).toBe(true);
    expect(a.readOnly).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cards.x.xp).toBe(7);
  });

  it('missing roster.json with a valid .bak is restored', () => {
    const seed = store('S');
    seed.addDelta('x', { xp: 7 });
    seed.flush();
    seed.tryClaim('y', 's0');
    fs.rmSync(file);
    const a = store('A');
    expect(a.readOnly).toBe(false);
    expect(a.get('x').xp).toBe(7);
  });

  it('both files bad: read-only and the original bytes are untouched', () => {
    fs.writeFileSync(file, BAD);
    fs.writeFileSync(file + '.bak', '');
    const a = store('A');
    expect(a.readOnly).toBe(true);
    a.addDelta('x', { xp: 5 });
    a.flush();
    expect(a.tryClaim('x', 's1')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(BAD);
    expect(fs.readFileSync(file + '.bak', 'utf8')).toBe('');
    expect(corruptCopies()).toHaveLength(1);
  });
});
