import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { retryTransient } from '../../lib/acceptance-transient';

function resilientRequest(request: APIRequestContext): APIRequestContext {
  const get = request.get.bind(request);
  return new Proxy(request, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (url: Parameters<APIRequestContext['get']>[0], options?: Parameters<APIRequestContext['get']>[1]) => retryTransient(attempt => get(url, {
          timeout: 15_000,
          ...options,
          maxRetries: Math.max(2, options?.maxRetries ?? 2),
          headers: attempt === 0 ? options?.headers : { ...options?.headers, connection: 'close' },
        }));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function resilientPage(page: Page) {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = (url, options) => retryTransient(() => goto(url, options));
  page.reload = options => retryTransient(() => reload(options));
  return page;
}

export const test = base.extend({
  request: async ({ request }, use) => { await use(resilientRequest(request)); },
  page: async ({ page }, use) => { await use(resilientPage(page)); },
});

export { expect };
