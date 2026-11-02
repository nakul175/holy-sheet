import { expect, it } from "vitest";
import { enqueuePageRead, pageReadDepth } from "./page-read-queue";

it("runs page reads one at a time and reports queued work", async () => {
  let active = 0;
  let peak = 0;
  const run = () => enqueuePageRead(async () => {
    active += 1;
    peak = Math.max(peak, active);
    expect(pageReadDepth()).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  });
  await Promise.all([run(), run(), run()]);
  expect(peak).toBe(1);
  expect(pageReadDepth()).toBe(0);
});
