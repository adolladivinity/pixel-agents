import * as fs from 'fs';
import * as path from 'path';

import type { CardDelta, CardStats } from './types.js';

/** A claim goes stale when its owner has not heartbeated for this long. */
const CLAIM_STALE_MS = 60_000;
/** A lock file older than this belongs to a process that died holding it. */
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 50;
/** Reads that fail for a reason other than "missing" (antivirus, handle limits) are retried. */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 20;
/** Largest value a stat may hold. Anything outside [0, MAX_STAT] marks the file corrupt. */
const MAX_STAT = 1e12;

const NUMERIC_FIELDS = ['xp', 'workedSeconds', 'tasksCompleted', 'lifetimeTokens'] as const;

interface InUseEntry {
  processId: string;
  agentKey: string;
  heartbeatAt: number;
}

interface RosterFile {
  version: 1;
  cards: Record<string, CardStats>;
  inUse: Record<string, InUseEntry>;
}

type ReadResult =
  | { kind: 'ok'; data: RosterFile; restored?: boolean }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unreadable' };

export interface RosterStoreOptions {
  filePath: string;
  /** Identifies this process in `inUse`; must differ between concurrently running processes. */
  processId: string;
  /** Clock for heartbeats, staleness and firstSeen/lastSeen. Defaults to Date.now. */
  now?: () => number;
  /** Warning sink (the store never imports vscode). Defaults to console.warn. */
  log?: (msg: string) => void;
  /** How long to wait for the lock before giving up. Defaults to 2 s; tests shorten it. */
  lockTimeoutMs?: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validStat(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_STAT;
}

function emptyStats(): CardStats {
  return {
    xp: 0,
    workedSeconds: 0,
    tasksCompleted: 0,
    lifetimeTokens: 0,
    firstSeen: '',
    lastSeen: '',
  };
}

/**
 * Per-card stats and "who is using this card" markers, shared by every Pixel Agents process
 * through one JSON file. Every write is a locked read-modify-write (lock file, temp file, rename),
 * so two processes never lose each other's deltas. A file that cannot be parsed or fails
 * validation is copied to `roster.json.corrupt-<timestamp>` and the store goes read-only for the
 * session: it never writes the file, the lock or the temp file, and keeps deltas and claims in memory.
 *
 * Durability: the temp file is fsynced before the rename, and the last good file is rotated to
 * `roster.json.bak` before it is replaced, so a crash at any point leaves at least one valid file.
 * If `roster.json` is missing, empty or corrupt but `.bak` is valid, the corrupt file is copied
 * aside, the store loads `.bak` and the next write puts it back; the store stays writable. Only
 * when both are unusable does it go read-only as above.
 *
 * Lock staleness uses the lock file's mtime against real time (Date.now), because mtime is real
 * time too; claim staleness and firstSeen/lastSeen use the injectable `now`.
 */
export class RosterStore {
  private readonly filePath: string;
  private readonly processId: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly lockTimeoutMs: number;
  private isReadOnly = false;
  /** The corrupt roster.json has been copied aside already (once per process is enough). */
  private corruptCopied = false;
  /** Last persisted view, refreshed on every read. */
  private cards: Record<string, CardStats> = {};
  /** Unflushed amounts to add on top of `cards`. */
  private readonly pending = new Map<string, Required<CardDelta>>();
  /** Claims this process holds. Mirrored into the file normally, authoritative when read-only. */
  private readonly owned = new Map<string, { agentKey: string; heartbeatAt: number }>();

  constructor(opts: RosterStoreOptions) {
    this.filePath = opts.filePath;
    this.processId = opts.processId;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    const result = this.readFile();
    if (result.kind === 'ok') this.cards = result.data.cards;
  }

  get readOnly(): boolean {
    return this.isReadOnly;
  }

  get(cardId: string): CardStats {
    const base = this.cards[cardId] ?? emptyStats();
    const add = this.pending.get(cardId);
    if (!add) return { ...base };
    return {
      ...base,
      xp: Math.min(MAX_STAT, base.xp + add.xp),
      workedSeconds: Math.min(MAX_STAT, base.workedSeconds + add.workedSeconds),
      tasksCompleted: Math.min(MAX_STAT, base.tasksCompleted + add.tasksCompleted),
      lifetimeTokens: Math.min(MAX_STAT, base.lifetimeTokens + add.lifetimeTokens),
    };
  }

  addDelta(cardId: string, delta: CardDelta): void {
    const add = this.pending.get(cardId) ?? {
      xp: 0,
      workedSeconds: 0,
      tasksCompleted: 0,
      lifetimeTokens: 0,
    };
    for (const field of NUMERIC_FIELDS) {
      const v = delta[field];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0)
        add[field] = Math.min(MAX_STAT, add[field] + v);
    }
    this.pending.set(cardId, add);
  }

  /** Write pending deltas into the shared file. Synchronous so it can run at shutdown. */
  flush(): void {
    if (this.isReadOnly || this.pending.size === 0) return;
    const ok = this.update((data) => {
      const iso = new Date(this.now()).toISOString();
      for (const [id, add] of this.pending) {
        const stats = data.cards[id] ?? emptyStats();
        for (const field of NUMERIC_FIELDS)
          stats[field] = Math.min(MAX_STAT, stats[field] + add[field]);
        if (!stats.firstSeen) stats.firstSeen = iso;
        stats.lastSeen = iso;
        data.cards[id] = stats;
      }
      return true;
    });
    if (ok) this.pending.clear();
  }

  tryClaim(cardId: string, agentKey: string): boolean {
    if (this.isReadOnly) return this.claimInMemory(cardId, agentKey);
    let granted = false;
    const ok = this.update((data) => {
      const existing = data.inUse[cardId];
      const t = this.now();
      if (existing && t - existing.heartbeatAt < CLAIM_STALE_MS) {
        // The same session id may take over another process's fresh claim: after an unclean
        // shutdown the dead window's claim looks alive for 60 s, and reopening VS Code in that
        // window must give restored agents their cards back. A different session never does.
        const sameAgent =
          existing.agentKey === agentKey &&
          (agentKey !== '' || existing.processId === this.processId);
        if (!sameAgent) return false;
      }
      data.inUse[cardId] = { processId: this.processId, agentKey, heartbeatAt: t };
      granted = true;
      return true;
    });
    if (this.isReadOnly) return this.claimInMemory(cardId, agentKey);
    if (!ok || !granted) return false;
    this.owned.set(cardId, { agentKey, heartbeatAt: this.now() });
    return true;
  }

  release(cardId: string): void {
    this.owned.delete(cardId);
    if (this.isReadOnly) return;
    this.update((data) => {
      if (data.inUse[cardId]?.processId !== this.processId) return false;
      delete data.inUse[cardId];
      return true;
    });
  }

  /** Refresh every claim this process holds. Call at least every ~20 s. */
  heartbeat(): void {
    if (this.owned.size === 0) return;
    const t = this.now();
    for (const claim of this.owned.values()) claim.heartbeatAt = t;
    if (this.isReadOnly) return;
    this.update((data) => {
      for (const [cardId, claim] of this.owned) {
        const existing = data.inUse[cardId];
        // Re-add a claim another process pruned, but never steal one a live process took over.
        if (
          existing &&
          existing.processId !== this.processId &&
          t - existing.heartbeatAt < CLAIM_STALE_MS
        )
          continue;
        data.inUse[cardId] = {
          processId: this.processId,
          agentKey: claim.agentKey,
          heartbeatAt: t,
        };
      }
      return true;
    });
  }

  /** Card ids with a fresh claim from another process. Always empty once read-only. */
  claimedByOthers(): Set<string> {
    const out = new Set<string>();
    if (this.isReadOnly) return out;
    const result = this.readFile();
    if (result.kind !== 'ok') return out;
    const t = this.now();
    for (const [id, entry] of Object.entries(result.data.inUse)) {
      if (entry.processId !== this.processId && t - entry.heartbeatAt < CLAIM_STALE_MS) out.add(id);
    }
    return out;
  }

  private claimInMemory(cardId: string, agentKey: string): boolean {
    const existing = this.owned.get(cardId);
    if (
      existing &&
      this.now() - existing.heartbeatAt < CLAIM_STALE_MS &&
      existing.agentKey !== agentKey
    ) {
      return false;
    }
    this.owned.set(cardId, { agentKey, heartbeatAt: this.now() });
    return true;
  }

  /**
   * Locked read-modify-write. `mutate` edits the freshly read data and returns true if it should be
   * saved. Returns true when the mutation ran (and was saved if requested); false when the lock
   * could not be taken, the file went corrupt, the write failed, or `mutate` returned false.
   */
  private update(mutate: (data: RosterFile) => boolean): boolean {
    if (this.isReadOnly) return false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      this.log(`[roster] cannot create ${path.dirname(this.filePath)}: ${String(err)}`);
      return false;
    }
    if (!this.acquireLock()) {
      this.log(`[roster] could not lock ${this.filePath}; will retry later`);
      return false;
    }
    try {
      const result = this.readFile();
      if (result.kind === 'corrupt' || result.kind === 'unreadable') return false;
      const data: RosterFile =
        result.kind === 'ok' ? result.data : { version: 1, cards: {}, inUse: {} };
      const restored = result.kind === 'ok' && result.restored === true;
      this.pruneStale(data);
      // A restore must reach the disk even when the caller has nothing to change.
      if (!mutate(data) && !restored) return false;
      // Rotate only a roster.json that was just read as valid: never copy a bad file over the .bak.
      if (result.kind === 'ok' && !restored) this.rotateBackup();
      this.writeDurably(this.filePath, JSON.stringify(data, null, 2));
      this.cards = data.cards;
      return true;
    } catch (err) {
      this.log(`[roster] write to ${this.filePath} failed: ${String(err)}`);
      return false;
    } finally {
      this.releaseLock();
    }
  }

  /** Write to a temp file, fsync it, then rename: a power cut leaves the old file or the new one. */
  private writeDurably(target: string, text: string): void {
    const tmp = target + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }

  /** Keep the current (valid) roster.json as roster.json.bak. A failure is logged, never fatal. */
  private rotateBackup(): void {
    const bak = this.backupPath();
    try {
      this.writeDurably(bak, fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      this.log(`[roster] could not refresh ${bak}: ${String(err)}`);
    }
  }

  private backupPath(): string {
    return this.filePath + '.bak';
  }

  private pruneStale(data: RosterFile): void {
    const t = this.now();
    for (const [id, entry] of Object.entries(data.inUse)) {
      if (entry.processId !== this.processId && t - entry.heartbeatAt >= CLAIM_STALE_MS)
        delete data.inUse[id];
    }
  }

  private acquireLock(): boolean {
    const lock = this.filePath + '.lock';
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx'));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.log(`[roster] cannot create lock ${lock}: ${String(err)}`);
          return false;
        }
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch (err) {
        // Lock vanished between open and stat: retry straight away. Any other failure (stat or
        // remove keeps throwing) must still honour the deadline and sleep, or this loop would spin.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) return false;
      sleepSync(LOCK_RETRY_MS);
    }
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.filePath + '.lock', { force: true });
    } catch {
      // A leftover lock goes stale after 10 s.
    }
  }

  /**
   * Read and validate the file. A file that parses badly is backed up and flips the store to
   * read-only. A file that cannot be read at all (EBUSY, EPERM, EMFILE, ...) is only "unreadable":
   * retried a few times, then reported without a backup or read-only, so the next call tries again.
   */
  private readFile(): ReadResult {
    let text: string | undefined;
    for (let attempt = 1; text === undefined; attempt++) {
      try {
        text = fs.readFileSync(this.filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.fromBackup('missing');
        if (attempt >= READ_ATTEMPTS) {
          this.log(
            `[roster] cannot read ${this.filePath} right now, will retry later: ${String(err)}`,
          );
          return { kind: 'unreadable' };
        }
        sleepSync(READ_RETRY_MS);
      }
    }
    const data = this.parse(text);
    if (!data) return this.fromBackup('corrupt');
    return { kind: 'ok', data };
  }

  /**
   * roster.json is missing or unparsable: use roster.json.bak if it is valid (copying a corrupt
   * roster.json aside first), otherwise report missing / go read-only as before.
   */
  private fromBackup(problem: 'missing' | 'corrupt'): ReadResult {
    let bakText: string | undefined;
    try {
      bakText = fs.readFileSync(this.backupPath(), 'utf8');
    } catch {
      // No (readable) backup.
    }
    const bak = bakText === undefined ? null : this.parse(bakText);
    if (bak) {
      if (problem === 'corrupt') this.copyCorruptAside(this.filePath);
      this.log(
        `[roster] ${this.filePath} was ${problem === 'missing' ? 'missing' : 'unusable'}; ` +
          `restored your stats from ${this.backupPath()}.`,
      );
      return { kind: 'ok', data: bak, restored: true };
    }
    if (problem === 'missing' && bakText === undefined) return { kind: 'missing' };
    // Corrupt roster.json, or a missing one next to a backup that is unusable too: starting empty
    // could overwrite real progress, so go read-only on whichever file exists.
    this.markCorrupt(
      problem === 'corrupt' ? this.filePath : this.backupPath(),
      'it is not a valid roster file',
    );
    return { kind: 'corrupt' };
  }

  private parse(text: string): RosterFile | null {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(raw) || raw.version !== 1 || !isObject(raw.cards) || !isObject(raw.inUse))
      return null;
    const cards: Record<string, CardStats> = {};
    for (const [id, c] of Object.entries(raw.cards)) {
      if (!isObject(c)) return null;
      for (const field of NUMERIC_FIELDS) {
        if (c[field] !== undefined && !validStat(c[field])) return null;
      }
      // Spread keeps unknown extra fields, so a newer version's data survives a round trip.
      const stats = { ...emptyStats(), ...c } as CardStats;
      if (typeof stats.firstSeen !== 'string') stats.firstSeen = '';
      if (typeof stats.lastSeen !== 'string') stats.lastSeen = '';
      cards[id] = stats;
    }
    const inUse: Record<string, InUseEntry> = {};
    for (const [id, e] of Object.entries(raw.inUse)) {
      if (!isObject(e) || typeof e.processId !== 'string' || typeof e.heartbeatAt !== 'number')
        continue;
      inUse[id] = {
        processId: e.processId,
        agentKey: String(e.agentKey ?? ''),
        heartbeatAt: e.heartbeatAt,
      };
    }
    return { version: 1, cards, inUse };
  }

  private markCorrupt(file: string, reason: string): void {
    this.isReadOnly = true;
    const backup = this.copyCorruptAside(file);
    if (backup) {
      this.log(
        `[roster] ${file} is unusable (${reason}). Copied it to ${backup}. ` +
          'Roster stats are read-only this session and nothing will be written to it.',
      );
    } else {
      this.log(
        `[roster] ${file} is unusable (${reason}) and the backup failed. ` +
          'Roster stats are read-only this session.',
      );
    }
  }

  /** Copy a bad file to `<file>.corrupt-<timestamp>`; returns the copy's path, or null on failure. */
  private copyCorruptAside(file: string): string | null {
    if (file === this.filePath) {
      if (this.corruptCopied) return null;
      this.corruptCopied = true;
    }
    let backup = `${file}.corrupt-${Date.now()}`;
    try {
      for (let i = 1; fs.existsSync(backup); i++) backup = `${file}.corrupt-${Date.now()}-${i}`;
      fs.copyFileSync(file, backup);
      return backup;
    } catch (err) {
      this.log(`[roster] could not copy ${file} aside: ${String(err)}`);
      return null;
    }
  }
}
