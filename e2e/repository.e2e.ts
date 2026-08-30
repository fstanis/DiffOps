import { expect, test } from '@playwright/test';

// The native directory picker cannot be automated, so showDirectoryPicker is
// replaced from inside the page with a real OPFS directory handle holding a
// copy of the served engine fixture (dist/pwa/fixture). Everything
// downstream — the walk, the WORKERFS mount, the wasm-git engine, the diff —
// runs the exact production code a picked folder exercises.
const installOpfsPicker = `
  window.showDirectoryPicker = async () => {
    const manifest = await (await fetch('/fixture/manifest.json')).json();
    const root = await navigator.storage.getDirectory();
    const repo = await root.getDirectoryHandle('fixture-repo', { create: true });
    const dirs = new Map();
    const dirFor = async (segments) => {
      let dir = repo;
      let prefix = '';
      for (const segment of segments) {
        prefix = prefix ? prefix + '/' + segment : segment;
        if (!dirs.has(prefix)) {
          dirs.set(prefix, await dir.getDirectoryHandle(segment, { create: true }));
        }
        dir = dirs.get(prefix);
      }
      return dir;
    };
    const paths = manifest.files;
    for (let offset = 0; offset < paths.length; offset += 16) {
      await Promise.all(paths.slice(offset, offset + 16).map(async (path) => {
        const segments = path.split('/');
        const parent = await dirFor(segments.slice(0, -1));
        const handle = await parent.getFileHandle(segments[segments.length - 1], { create: true });
        const response = await fetch('/fixture/' + encodeURI(path));
        if (!response.ok) {
          throw new Error('fixture fetch failed: ' + path);
        }
        const writable = await handle.createWritable();
        await writable.write(await response.arrayBuffer());
        await writable.close();
      }));
    }
    return repo;
  };
`;

test('picking the fixture repository renders its working diff through the wasm engine', async ({
  page,
}) => {
  await page.addInitScript(installOpfsPicker);
  await page.goto('/');

  await page.getByTestId('open-repo-button').click();

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

  // Refresh re-walks the mounted folder and re-renders without errors.
  await page.getByTestId('refresh-repo-button').click();
  await expect(page.getByRole('heading', { name: 'src/app.ts' })).toBeVisible({
    timeout: 60_000,
  });
});

test('changing the revision after reading a blob without trailing newline still resolves commits', async ({
  page,
}) => {
  await page.addInitScript(installOpfsPicker);
  await page.goto('/');

  await page.getByTestId('open-repo-button').click();

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
