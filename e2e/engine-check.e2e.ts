import { expect, test } from '@playwright/test';

// The in-browser engine check (src/standalone/engine-check.html) mounts the
// served fixture repository through the production worker + GitEngine and
// asserts its outcomes against expectations the real git CLI computed. This
// spec turns that page into a blocking e2e result: the poll resolves to the
// failed count only once the page reports it is done.
test('engine check passes every git-computed expectation', async ({ page }) => {
  await page.goto('/engine-check.html');

  await expect
    .poll(
      async () => {
        const report = await page.evaluate(
          () =>
            (window as { __ENGINE_CHECK__?: { isDone: boolean; failedCount: number } })
              .__ENGINE_CHECK__,
        );
        return report?.isDone ? report.failedCount : -1;
      },
      { timeout: 180_000 },
    )
    .toBe(0);
});
