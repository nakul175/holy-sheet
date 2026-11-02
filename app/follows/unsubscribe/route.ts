import { unsubscribeFromToken, unsubscribeResponse } from "../../../lib/page-follows";
import { repository } from "../../../lib/repository";

/** One-click unsubscribe. The response is the same for every token and names no page. */
async function finish(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try { await unsubscribeFromToken(await repository(false), token); } catch { /* Stay on the generic confirmation. */ }
  return unsubscribeResponse();
}

export function GET(request: Request) { return finish(request); }
export function POST(request: Request) { return finish(request); }
