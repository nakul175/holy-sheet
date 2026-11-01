import { test, type Page } from '@playwright/test';

/** Stop routed access and document handlers before the page closes. */
export async function releasePageRoutes(page: Page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
}

/** In-flight route.fetch calls must not fail the next test. */
export function releaseRoutesWhenDone() {
  test.afterEach(async ({ page }) => {
    await releasePageRoutes(page);
  });
}
