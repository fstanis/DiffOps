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

  // The window names the repository and the diff it is showing.
  await expect(page).toHaveURL(/#\/r\/fixture-repo\?base=HEAD&target=\./);

  // Refresh re-walks the mounted folder and re-renders without errors.
  await page.getByTestId('refresh-repo-button').click();
  await expect(page.getByRole('heading', { name: 'src/app.ts' })).toBeVisible({
    timeout: 60_000,
  });
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
