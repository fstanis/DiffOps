import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

// A real `git diff` output (renames, a binary file, a quoted non-ASCII path,
// a mode-only change) committed as the render fixture for the smoke specs.
const reviewDiff = readFileSync(new URL('fixtures/review.diff', import.meta.url), 'utf8');

// A .diff-only session must never start the git engine: neither the worker
// bundle nor the wasm binary hits the network.
const isEngineRequest = (url: URL): boolean =>
  /\/git-worker\.js$/.test(url.pathname) || /\/lg2_workerfs\.wasm$/.test(url.pathname);

const writeReviewDiff = (name: string): string => {
  const diffFile = test.info().outputPath(name);
  writeFileSync(diffFile, reviewDiff, 'utf8');
  return diffFile;
};

test('opening a .diff file renders the review without loading the git engine', async ({ page }) => {
  const engineRequests: string[] = [];
  page.on('request', (request) => {
    if (isEngineRequest(new URL(request.url()))) {
      engineRequests.push(request.url());
    }
  });

  await page.goto('/');
  await expect(page.getByText('Review a diff — no server needed')).toBeVisible();
  await page.setInputFiles('input[data-testid="diff-file-input"]', writeReviewDiff('review.diff'));

  // Git's file order starts with the binary file: its placeholder renders
  // where an empty chunk table used to.
  await expect(page.getByRole('heading', { name: 'assets/logo.bin' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('binary-file-placeholder').first()).toBeVisible();

  // Clicking the sidebar entry scrolls the lazily-rendered file into view —
  // the rename keeps its label, hunks and line numbers render.
  await page.locator('#file-tree-panel span[title="docs/handbook.md"]').click();
  await expect(page.getByRole('heading', { name: 'docs/handbook.md' })).toBeVisible();
  await expect(page.getByText('renamed from docs/guide.md')).toBeVisible();
  await expect(page.getByText('plus a fourth').first()).toBeVisible();

  expect(engineRequests).toEqual([]);
});

test('the sidebar lists every file of the opened diff, folder-grouped', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[data-testid="diff-file-input"]', writeReviewDiff('review.diff'));

  const fileTree = page.locator('#file-tree-panel');
  await expect(page.getByRole('heading', { name: 'assets/logo.bin' })).toBeVisible({
    timeout: 30_000,
  });

  for (const entry of [
    'assets/logo.bin',
    'docs/handbook.md',
    'fancy naïve file.txt',
    'footer.txt',
    'notes/archived.txt',
    'notes/gone.txt',
    'package-lock.json',
    'scripts/run.sh',
    'src/app.ts',
    'src/new.ts',
  ]) {
    await expect(fileTree.locator(`span[title="${entry}"]`)).toBeVisible();
  }
});
