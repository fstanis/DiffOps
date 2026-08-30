import { expect, type Page } from '@playwright/test';

// The native directory picker cannot be automated, so showDirectoryPicker is
// replaced from inside the page with a real OPFS directory handle holding a
// copy of the served engine fixture (dist/pwa/fixture); downstream code then
// runs the exact production path a picked folder would exercise.
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

const FIXTURE_FOLDER_NAME = 'fixture-repo';

/** The expectations the fixture generator computed with the real git CLI. */
interface FixtureExpectations {
  wideBase: string;
  wideTarget: string;
  wideFileCount: number;
}

export const readFixtureExpectations = async (page: Page): Promise<FixtureExpectations> => {
  const response = await page.request.get('/fixture/manifest.json');
  const manifest = (await response.json()) as { expected: FixtureExpectations };
  return manifest.expected;
};

/**
 * Registers the served engine fixture on the launcher, then routes to its
 * repository window. The two-window flow is covered at the component seam;
 * here the hash route mounts the same repository in one page.
 */
export const openFixtureRepository = async (page: Page, search = ''): Promise<void> => {
  await page.addInitScript(installOpfsPicker);
  await page.goto('/');

  await page.getByTestId('register-repo-button').click();
  await expect(page.getByRole('button', { name: FIXTURE_FOLDER_NAME, exact: true })).toBeVisible({
    timeout: 120_000,
  });

  await page.goto(`/#/r/${FIXTURE_FOLDER_NAME}${search}`);
};
