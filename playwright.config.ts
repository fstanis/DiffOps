import { defineConfig } from '@playwright/test';

// E2E smoke for the built PWA against the Bun server (`bun run serve`). The
// specs are `*.e2e.ts` so `bun test` (which also globs *.spec.ts) never picks
// them up — Playwright stays a Node tool, independent of the app's toolchain.
// The webServer chain builds the app, regenerates the engine fixture into
// dist/pwa/fixture, and serves everything on :4173.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'bun scripts/build.ts && bun scripts/make-engine-fixture-repo.mjs dist/pwa/fixture && bun src/server/serve.ts',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
  outputDir: './test-results',
});
