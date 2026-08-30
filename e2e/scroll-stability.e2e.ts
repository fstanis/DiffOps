import { expect, test, type Page } from '@playwright/test';

import { openFixtureRepository, readFixtureExpectations } from './fixtureRepository';

// Row virtualization binds every chunk to the app's single scroll container,
// which the virtualizer would otherwise treat as its own: these specs pin the
// scroll position against that. They need a diff big enough for files to render
// lazily and for rows to fall outside the mounted range, which is the fixture
// repository's `wide` branch (see scripts/make-engine-fixture-repo.mjs).
const openWideDiff = async (page: Page): Promise<void> => {
  const { wideBase, wideTarget } = await readFixtureExpectations(page);
  await openFixtureRepository(page, `?base=${wideBase}&target=${wideTarget}`);
  await expect(page.getByRole('heading', { name: 'src/module00/generated00.ts' })).toBeVisible({
    timeout: 120_000,
  });
};

/** Where the file's section sits relative to the scroll container's top edge. */
const fileOffsetFromContainerTop = (page: Page, filePath: string): Promise<number> =>
  page.evaluate((path) => {
    const container = document.querySelector('main.overflow-y-auto') as HTMLElement;
    const section = document.querySelector(`[data-file-path="${path}"]`) as HTMLElement;
    return Math.round(section.getBoundingClientRect().top - container.getBoundingClientRect().top);
  }, filePath);

const scrollTop = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.round((document.querySelector('main.overflow-y-auto') as HTMLElement).scrollTop),
  );

/**
 * Whether a real diff row — not a spacer standing in for the unmounted ones —
 * covers the middle of the viewport. False means the mounted range has drifted
 * away from where the container actually is, which reads as a blank stripe.
 */
const viewportCenterHasRow = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const container = document.querySelector('main.overflow-y-auto') as HTMLElement;
    const rect = container.getBoundingClientRect();
    const element = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return Boolean(element?.closest('tr[data-diff-line-row]'));
  });

test.use({ viewport: { width: 1400, height: 900 } });

test('clicking a sidebar file leaves its header flush with the top of the viewport', async ({
  page,
}) => {
  await openWideDiff(page);

  const target = 'src/module20/generated20.ts';
  await page.locator(`#file-tree-panel span[title="${target}"]`).click();

  // Rendering the files above the target grows the page under the scroll
  // position; the offset has to survive that, not just be right for one frame.
  await page.waitForTimeout(2000);
  expect(Math.abs(await fileOffsetFromContainerTop(page, target))).toBeLessThanOrEqual(2);
});

test('switching a file between view modes holds the scroll position', async ({ page }) => {
  await openWideDiff(page);

  const target = 'src/module05/generated05.ts';
  await page.locator(`#file-tree-panel span[title="${target}"]`).click();
  await page.waitForTimeout(2000);

  const before = await scrollTop(page);
  expect(before).toBeGreaterThan(1000);

  const fileSection = page.locator(`[data-file-path="${target}"]`);
  for (const mode of ['Split', 'Unified', 'Split'] as const) {
    await fileSection.getByRole('button', { name: mode, exact: true }).click();
    await page.waitForTimeout(1000);

    // Mounting a chunk used to reset the shared container to the top.
    expect(await scrollTop(page)).toBe(before);
    expect(Math.abs(await fileOffsetFromContainerTop(page, target))).toBeLessThanOrEqual(2);
    expect(await viewportCenterHasRow(page)).toBe(true);
  }
});

test('scrolling hard through a long diff never puts a row in a re-measure loop', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await openWideDiff(page);

  // A row's measured height must not depend on which rows happen to be mounted.
  // When it did, measuring changed the range, the range changed the wrapping,
  // and React tore the tree down with "Maximum update depth exceeded".
  await page.evaluate(async () => {
    const container = document.querySelector('main.overflow-y-auto') as HTMLElement;
    container.scrollTop = 0;
    for (let step = 0; step < 60; step++) {
      container.scrollTop += 800;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  await page.waitForTimeout(1000);

  expect(pageErrors).toEqual([]);
  // The tree is still mounted, and rows are still being produced.
  expect(await viewportCenterHasRow(page)).toBe(true);
});

test('] continues from the file picked in the sidebar, not from the last ]', async ({ page }) => {
  await openWideDiff(page);

  const cursorFilePath = () =>
    page.evaluate(() => {
      const section = document.querySelector('.keyboard-cursor')?.closest('[data-file-path]');
      return (section as HTMLElement | null)?.dataset.filePath ?? null;
    });

  // Each press reads the committed cursor, so they have to land one at a time.
  for (const expected of [
    'src/module00/generated00.ts',
    'src/module01/generated01.ts',
    'src/module02/generated02.ts',
  ]) {
    await page.keyboard.press(']');
    await expect.poll(cursorFilePath).toBe(expected);
  }

  await page.locator('#file-tree-panel span[title="src/module10/generated10.ts"]').click();
  await page.waitForTimeout(1500);

  await page.keyboard.press(']');
  await expect.poll(cursorFilePath).toBe('src/module11/generated11.ts');

  await page.keyboard.press('[');
  await expect.poll(cursorFilePath).toBe('src/module10/generated10.ts');
});
