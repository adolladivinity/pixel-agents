/**
 * The office character looks like its roster card. The look arrives in
 * `agentRoster`, which can land before or after the character exists, so
 * OfficeState keeps it and applies it on either order. Temps (no look) keep
 * the palette and hue the server picked.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { setCharacterTemplates } from '../src/office/sprites/spriteData.js';

test('a look set after the agent exists is applied to its character', () => {
  const os = new OfficeState();
  os.addAgent(1, 2, 0);
  os.setCardLook(1, undefined, 25);
  const ch = os.characters.get(1)!;
  // Only the 6 bundled sheets are loaded in a unit test, so card 25 falls back.
  assert.equal(ch.palette, 25 % 6);
  assert.equal(ch.hueShift, (25 * 47) % 360);
});

test('a look that arrives before the agent is applied when it is created', () => {
  const os = new OfficeState();
  os.setCardLook(7, undefined, 5);
  os.addAgent(7, 1, 200);
  const ch = os.characters.get(7)!;
  assert.equal(ch.palette, 5);
  assert.equal(ch.hueShift, 0);
});

test('a temp gets a bundled sheet with a non-zero hue, not the server pick', () => {
  const os = new OfficeState();
  os.addAgent(3, 1, 0);
  os.setCardLook(3, undefined, 'temp');
  const ch = os.characters.get(3)!;
  assert.ok(ch.palette >= 0 && ch.palette < 6);
  assert.notEqual(ch.hueShift, 0);
});

test('two temps look different from each other', () => {
  const os = new OfficeState();
  os.addAgent(3, 0, 0);
  os.addAgent(4, 0, 0);
  os.setCardLook(3, undefined, 'temp');
  os.setCardLook(4, undefined, 'temp');
  const a = os.characters.get(3)!;
  const b = os.characters.get(4)!;
  assert.notDeepEqual([a.palette, a.hueShift], [b.palette, b.hueShift]);
});

test('a temp never looks like a loaded card, even a card with a bundled sheet', () => {
  const os = new OfficeState();
  os.addAgent(9, 0, 0);
  os.addAgent(10, 0, 0);
  os.setCardLook(9, undefined, 'temp');
  for (let card = 0; card < 6; card++) {
    os.setCardLook(10, undefined, card);
    const t = os.characters.get(9)!;
    const c = os.characters.get(10)!;
    assert.notDeepEqual([t.palette, t.hueShift], [c.palette, c.hueShift]);
  }
});

test('a temp look that arrives before the agent is applied at creation', () => {
  const os = new OfficeState();
  os.setCardLook(5, undefined, 'temp');
  os.addAgent(5, 2, 0);
  assert.notEqual(os.characters.get(5)!.hueShift, 0);
});

test('a sub-agent takes its own card look, not the parent look', () => {
  const os = new OfficeState();
  os.addAgent(1, 0, 0);
  os.setCardLook(1, undefined, 3);
  os.setCardLook(1, 'tool-a', 4);
  const subId = os.addSubagent(1, 'tool-a');
  assert.equal(os.characters.get(subId)!.palette, 4);
  assert.equal(os.characters.get(subId)!.hueShift, 0);
  // A sub-agent with no card of its own still inherits the parent's look.
  const other = os.addSubagent(1, 'tool-b');
  assert.equal(os.characters.get(other)!.palette, 3);
});

test('a look set after a sub-agent spawned is applied to it', () => {
  const os = new OfficeState();
  os.addAgent(1, 0, 0);
  const subId = os.addSubagent(1, 'tool-a');
  os.setCardLook(1, 'tool-a', 4);
  assert.equal(os.characters.get(subId)!.palette, 4);
  assert.equal(os.characters.get(subId)!.hueShift, 0);
});

test('a card whose sheet loads later switches from the fallback to its own sheet', () => {
  const os = new OfficeState();
  os.addAgent(1, 0, 0);
  os.setCardLook(1, undefined, 22);
  assert.equal(os.characters.get(1)!.hueShift, (22 * 47) % 360);
  // The asset directory finishes loading: 22 sheets (6 bundled + 16 external) plus the new 8 = 30.
  setCharacterTemplates(Array.from({ length: 30 }, () => ({ down: [], up: [], right: [] })));
  os.refreshCardLooks();
  assert.equal(os.characters.get(1)!.palette, 22);
  assert.equal(os.characters.get(1)!.hueShift, 0);
});
