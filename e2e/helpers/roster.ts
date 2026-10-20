import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { narrate } from './test-narration';

type Surface = Frame | Page;

const ROSTER_TIMEOUT_MS = 20_000;

/** The roster side panel (one at a time). */
export function getRosterPanel(frame: Surface): Locator {
  return frame.locator('[data-testid="roster-panel"]');
}

export function getRosterName(frame: Surface): Locator {
  return frame.locator('[data-testid="roster-name"]');
}

export function getRosterLevel(frame: Surface): Locator {
  return frame.locator('[data-testid="roster-level"]');
}

export function getRosterClose(frame: Surface): Locator {
  return frame.getByRole('button', { name: 'Close roster panel' });
}

interface CenterHooksWindow {
  __pixelAgentsTestHooks?: {
    getCharacterCenter?: (id: number) => { x: number; y: number } | null;
  };
}

/**
 * A real left click on a character, through OfficeCanvas's own hit-testing, so
 * the click takes the exact path a user's does (selection, focusAgent, roster
 * panel). The point comes from the renderer's projection via the
 * getCharacterCenter hook; the canvas box places it on the page. Fails loudly
 * when something other than the canvas covers the point.
 */
export async function clickCharacter(frame: Frame, agentId: number): Promise<void> {
  const canvas = frame.locator('[data-testid="office-canvas"]');
  await expect(canvas).toBeVisible({ timeout: ROSTER_TIMEOUT_MS });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('office canvas is not rendered');
  const local = await frame.evaluate((id) => {
    const center = (
      window as unknown as CenterHooksWindow
    ).__pixelAgentsTestHooks?.getCharacterCenter?.(id);
    const el = document.querySelector('[data-testid="office-canvas"]');
    if (!center || !el) return null;
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + center.x, rect.top + center.y);
    return { ...center, onCanvas: top === el };
  }, agentId);
  if (!local) throw new Error(`character ${agentId} has no projection yet`);
  if (!local.onCanvas) throw new Error(`character ${agentId} is covered, not clickable on canvas`);
  narrate.step(`clicking character ${agentId} on the canvas`);
  await frame.page().mouse.click(box.x + local.x, box.y + local.y);
}

/**
 * A real click on bare canvas: the first of a few probe points (mostly the
 * open space below the map) where the canvas is the topmost element. It is the
 * "click empty floor" gesture without hard-coding layout coordinates.
 */
export async function clickEmptyCanvas(frame: Frame): Promise<void> {
  const canvas = frame.locator('[data-testid="office-canvas"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('office canvas is not rendered');
  // Fractions of the canvas, most-open first (below the map, away from the
  // toolbar and the zoom buttons). The covered-check runs in frame-local
  // coordinates; the click uses page coordinates from the canvas box.
  const probes: Array<[number, number]> = [
    [0.5, 0.75],
    [0.5, 0.9],
    [0.75, 0.75],
    [0.3, 0.75],
    [0.94, 0.5],
    [0.06, 0.5],
  ];
  for (const [fx, fy] of probes) {
    const onCanvas = await frame.evaluate(
      ([ox, oy]) => {
        const el = document.querySelector('[data-testid="office-canvas"]');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return (
          document.elementFromPoint(rect.left + rect.width * ox!, rect.top + rect.height * oy!) ===
          el
        );
      },
      [fx, fy] as const,
    );
    if (!onCanvas) continue;
    narrate.step('clicking bare canvas');
    await frame.page().mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    return;
  }
  throw new Error('no uncovered canvas point found for an empty-floor click');
}

export async function expectRosterPanelClosed(frame: Surface, timeout = 5_000): Promise<void> {
  await expect(getRosterPanel(frame)).toHaveCount(0, { timeout });
}

/** Wait for the panel to show a name and a "LV n" badge; returns the name. */
export async function expectRosterPanelWithNameAndLevel(
  frame: Surface,
  timeout = ROSTER_TIMEOUT_MS,
): Promise<string> {
  await expect(getRosterPanel(frame)).toBeVisible({ timeout });
  await expect(getRosterName(frame)).not.toHaveText('', { timeout });
  await expect(getRosterLevel(frame)).toHaveText(/^LV \d+$/, { timeout });
  const name = ((await getRosterName(frame).textContent()) ?? '').trim();
  narrate.check(`roster panel open for ${name}`);
  return name;
}
