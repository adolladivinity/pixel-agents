import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import { CardAssigner } from './cardAssigner.js';
import { RosterStore } from './rosterStore.js';
import { loadSeed } from './seed.js';

export function defaultRosterPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'roster.json');
}

/**
 * Production wiring for AgentRuntime: the bundled seed plus a RosterStore on
 * ~/.pixel-agents/roster.json. Pass it as a factory (`cardAssigner: createDefaultCardAssigner`)
 * so the file is only opened when the first agent appears.
 *
 * SEAM for the roster runtime task: this builds the store with no heartbeat, flush timers or
 * shutdown hook. The runtime that owns those replaces this factory and keeps the same
 * `AgentRuntimeOptions.cardAssigner` shape.
 */
export function createDefaultCardAssigner(filePath: string = defaultRosterPath()): CardAssigner {
  const store = new RosterStore({
    filePath,
    // Unique per process and per construction: two windows must never share an identity.
    processId: `${process.pid}-${randomUUID().slice(0, 8)}`,
    log: (msg) => console.warn(msg),
  });
  return new CardAssigner(loadSeed(), store);
}
