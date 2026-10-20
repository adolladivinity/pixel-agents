import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultCardAssigner, defaultRosterPath } from '../src/roster/defaultAssigner.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-assigner-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createDefaultCardAssigner', () => {
  it('builds an assigner over the bundled seed on the given roster file', () => {
    const file = path.join(dir, 'roster.json');
    const assigner = createDefaultCardAssigner(file);
    const got = assigner.assign('s', { isLead: true });
    expect(got.isTemp).toBe(false);
    // The claim is recorded in the shared file so other windows skip this card.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(onDisk.inUse)).toEqual([got.card!.id]);
  });

  it('gives each construction its own process identity', () => {
    const file = path.join(dir, 'roster.json');
    const a = createDefaultCardAssigner(file);
    const b = createDefaultCardAssigner(file);
    const one = a.assign('a', { isLead: true });
    const two = b.assign('b', { isLead: true });
    expect(two.card?.id).not.toBe(one.card?.id);
  });

  it('defaults to ~/.pixel-agents/roster.json', () => {
    expect(defaultRosterPath()).toBe(path.join(os.homedir(), '.pixel-agents', 'roster.json'));
  });
});
