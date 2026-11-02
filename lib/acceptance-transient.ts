// A dropped dev-server socket (ECONNRESET) is not a failed acceptance assertion.
// HOLY-93 collaboration polls treat the same socket errors as "try again".
const transientSocket = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|socket hang up|ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE/i;

export function isTransientSocket(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return transientSocket.test(message);
}

/** Bounded reads only. A committed POST is not retried, so a lost response cannot duplicate a write. */
export async function retryTransient<T>(run: (attempt: number) => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      last = error;
      if (!isTransientSocket(error) || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  throw last;
}
