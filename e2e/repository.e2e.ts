import { expect, test } from '@playwright/test';

import { openFixtureRepository } from './fixtureRepository';

test('the fixture repository renders its working diff through the wasm engine', async ({
  page,
}) => {
  await openFixtureRepository(page);

  // Default selection is all uncommitted changes: the unstaged src/app.ts
  // edit and the staged README edit (manifest.expected.workingChangedFiles
  // is 2, computed by the real git CLI).
  await expect(page.getByRole('heading', { name: 'src/app.ts' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText('UNSTAGED_MARKER').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'README.md' })).toBeVisible();

  const fileTree = page.locator('#file-tree-panel');
  await expect(fileTree.locator('span[title="src/app.ts"]')).toBeVisible();
  await expect(fileTree.locator('span[title="README.md"]')).toBeVisible();
  // The index-driven walk mounts only tracked files, so the fixture's
  // untracked node_modules and dist trees never reach the diff at all.
  await expect(fileTree.locator('span[title*="node_modules/"]')).toHaveCount(0);
  await expect(fileTree.locator('span[title*="dist/"]')).toHaveCount(0);

  // The window names the repository and the diff it is showing.
  await expect(page).toHaveURL(/#\/r\/fixture-repo\?base=HEAD&target=\./);

  // Refresh stays visible and neutral until the watched folder actually
  // changes on disk, then re-reads cleanly.
  const refreshButton = page.getByTestId('refresh-repo-button');
  await expect(refreshButton).toHaveAccessibleName('Refresh');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const repo = await root.getDirectoryHandle('fixture-repo', { create: true });
    const handle = await repo.getFileHandle('notes.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('changed on disk\n');
    await writable.close();
  });
  await expect(refreshButton).toHaveAccessibleName('Refresh · changes on disk');

  await refreshButton.click();
  await expect(page.getByRole('heading', { name: 'src/app.ts' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(refreshButton).toHaveAccessibleName('Refresh');
});

test('changing the revision after reading a blob without trailing newline still resolves commits', async ({
  page,
}) => {
  await openFixtureRepository(page);

  // Rendering the working diff reads each changed file's committed blob
  // (line-count, generated-status); zz-notes.md ends without a trailing
  // newline, which leaves lg2's stdout buffer dangling mid-line.
  await expect(page.getByRole('heading', { name: 'src/app.ts' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByRole('heading', { name: 'zz-notes.md' })).toBeVisible();

  await page.getByRole('button', { name: /^Revision menu:/ }).click();
  await page.getByRole('button', { name: 'Pick Commit...' }).click();
  // A bump commit: a real content change in src/app.ts (unlike HEAD, whose
  // whitespace-only tweak diffs to nothing with ignoreWhitespace on).
  await page
    .getByRole('button', { name: /bump app to v/ })
    .first()
    .click();

  // The dangling buffer used to glue itself onto this selection's
  // `rev-parse <shortHash>` and surface "Unknown revision".
  await expect(page.getByRole('heading', { name: 'Files changed (1)' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: 'src/app.ts' })).toBeVisible();
  await expect(page.getByText(/Unknown revision/)).not.toBeVisible();
});

test('a hash naming an unregistered folder explains itself and routes to the launcher', async ({
  page,
}) => {
  await page.goto('/#/r/never-registered');

  await expect(page.getByText(/not a registered repository/i)).toBeVisible();

  await page.getByRole('button', { name: 'Back to the launcher' }).click();

  await expect(page.getByRole('heading', { name: /Review a local repository/i })).toBeVisible();
});
