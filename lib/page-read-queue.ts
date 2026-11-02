/** One in-flight page read. Background polls share this so the dev server is not stampeded. */
let tail: Promise<void> = Promise.resolve();
let depth = 0;

export function pageReadDepth() {
  return depth;
}

export function enqueuePageRead<T>(run: () => Promise<T>): Promise<T> {
  depth += 1;
  const result = tail.then(run, run);
  tail = result.finally(() => { depth -= 1; }).then(() => undefined, () => undefined);
  return result;
}
