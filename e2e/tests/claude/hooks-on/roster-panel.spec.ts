import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import {
  closeAgentFromOverlay,
  expectAgentOverlayGone,
  expectAgentSelected,
  expectOverlayCount,
  expectSingleAgentOverlay,
  readAgentOverlayIds,
} from '../../../helpers/office';
import {
  clickCharacter,
  clickEmptyCanvas,
  expectRosterPanelClosed,
  expectRosterPanelWithNameAndLevel,
  getRosterClose,
  getRosterName,
  getRosterPanel,
} from '../../../helpers/roster';
import { enterEditMode, exitEditMode } from '../../../helpers/editor';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../../../helpers/webview';

const HOLD_OPEN_MS = 120_000;

test.describe('Hooks ON / roster side panel', () => {
  test('clicking a character opens the roster panel with a name and level @area:roster', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('roster panel open').holdOpenFor(HOLD_OPEN_MS).build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    narrator.step('checking the panel is closed before any click');
    await expectRosterPanelClosed(panelFrame, 1_000);

    narrator.step('clicking the character');
    await clickCharacter(panelFrame, agentId);
    const name = await expectRosterPanelWithNameAndLevel(panelFrame);
    expect(name.length).toBeGreaterThan(0);

    // The existing click behaviour is untouched: the character is selected too.
    await expectAgentSelected(panelFrame, agentId, true);
    narrator.check('panel open with a name and a level; the character is selected as before');
  });

  test('clicking another character switches the panel @area:roster', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    for (const label of ['roster switch one', 'roster switch two']) {
      await arrangeNextClaudeInvocation(
        tmpHome,
        claudeScenario(label).holdOpenFor(HOLD_OPEN_MS).build(),
      );
      await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    }
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2);
    const [first, second] = (await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b);

    await clickCharacter(panelFrame, first!);
    const firstName = await expectRosterPanelWithNameAndLevel(panelFrame);

    narrator.step('clicking the other character');
    await clickCharacter(panelFrame, second!);
    await expect(getRosterName(panelFrame)).not.toHaveText(firstName, { timeout: 20_000 });
    const secondName = await expectRosterPanelWithNameAndLevel(panelFrame);
    expect(secondName).not.toBe(firstName);
    // One panel, never one per character.
    await expect(getRosterPanel(panelFrame)).toHaveCount(1);
    narrator.check(`panel switched from ${firstName} to ${secondName}`);
  });

  test('close button closes it @area:roster', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('roster panel close').holdOpenFor(HOLD_OPEN_MS).build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    await clickCharacter(panelFrame, agentId);
    await expectRosterPanelWithNameAndLevel(panelFrame);

    // Touch-target guidance: the glyph is small but the hit area must not be.
    const closeBox = await getRosterClose(panelFrame).boundingBox();
    expect(closeBox!.width).toBeGreaterThanOrEqual(32);
    expect(closeBox!.height).toBeGreaterThanOrEqual(32);

    narrator.step('pressing the close button');
    await getRosterClose(panelFrame).click();
    await expectRosterPanelClosed(panelFrame);
    narrator.check('panel closed');
  });

  test('clicking empty floor keeps it open @area:roster', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('roster panel floor click').holdOpenFor(HOLD_OPEN_MS).build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    await clickCharacter(panelFrame, agentId);
    const name = await expectRosterPanelWithNameAndLevel(panelFrame);

    narrator.step('clicking bare canvas');
    await clickEmptyCanvas(panelFrame);
    // #393 deselects the office character on a bare click (its task board
    // follows that). The roster panel keeps its own target and stays put.
    await expectAgentSelected(panelFrame, agentId, false);
    await panelFrame.waitForTimeout(1_000);
    await expect(getRosterPanel(panelFrame)).toBeVisible();
    await expect(getRosterName(panelFrame)).toHaveText(name);
    narrator.check('office selection cleared, roster panel still showing the same agent');
  });

  test('panel closes when its agent is removed, and the next character shows its own name @area:roster', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    for (const label of ['roster removal one', 'roster removal two']) {
      await arrangeNextClaudeInvocation(
        tmpHome,
        claudeScenario(label).holdOpenFor(HOLD_OPEN_MS).build(),
      );
      await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    }
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 2);
    const [doomed, survivor] = (await readAgentOverlayIds(panelFrame)).sort((a, b) => a - b);

    await clickCharacter(panelFrame, doomed!);
    const doomedName = await expectRosterPanelWithNameAndLevel(panelFrame);

    narrator.step(`ending agent ${doomed} (its overlay close button)`);
    await closeAgentFromOverlay(panelFrame, { agentId: doomed! });
    await expectAgentOverlayGone(panelFrame, doomed!);
    await expectRosterPanelClosed(panelFrame, 10_000);
    narrator.check('the panel closed with its agent');

    // Nothing stale: the survivor's panel must show the survivor, not the card
    // the removed agent held.
    narrator.step('clicking the surviving character');
    await clickCharacter(panelFrame, survivor!);
    const survivorName = await expectRosterPanelWithNameAndLevel(panelFrame);
    expect(survivorName).not.toBe(doomedName);
    narrator.check(`panel shows ${survivorName}, not ${doomedName}`);
  });

  test('the dock never takes more than 45% of the width, and hides in the layout editor @area:roster', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('roster panel narrow and editor').holdOpenFor(HOLD_OPEN_MS).build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    await clickCharacter(panelFrame, agentId);
    const name = await expectRosterPanelWithNameAndLevel(panelFrame);

    narrator.step('checking the dock leaves room for the office');
    const panelBox = await getRosterPanel(panelFrame).boundingBox();
    const viewportWidth = await panelFrame.evaluate(() => window.innerWidth);
    expect(panelBox!.width).toBeLessThanOrEqual(300.5);
    expect(panelBox!.width).toBeLessThanOrEqual(viewportWidth * 0.45 + 1);

    narrator.step('entering the layout editor');
    await enterEditMode(panelFrame);
    await expectRosterPanelClosed(panelFrame);

    narrator.step('leaving the layout editor');
    await exitEditMode(panelFrame);
    await expect(getRosterPanel(panelFrame)).toBeVisible({ timeout: 20_000 });
    await expect(getRosterName(panelFrame)).toHaveText(name);
    narrator.check('dock stays within 45%, hides in edit mode, returns with the same agent');
  });
});
