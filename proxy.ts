import { NextResponse, type NextRequest } from "next/server";
import { authenticate, localPreview } from "./lib/auth";
import { repository } from "./lib/repository";
import { resolvePublishedPage } from "./lib/published-pages";
import { readSpaceBySlug, SPACE_UNAVAILABLE } from "./lib/space-directory";

function unavailableSpace() {
  return NextResponse.json(
    { error: SPACE_UNAVAILABLE, code: "not_found", retryable: false },
    { status: 404, headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } },
  );
}

/** Old published addresses answer 301 before the page renders. Denied slugs are not redirected. */
export async function proxy(request: NextRequest) {
  const spaceMatch = request.nextUrl.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (spaceMatch && request.headers.get("accept")?.includes("application/json")) {
    try {
      const actor = await authenticate(request);
      const found = await readSpaceBySlug(
        await repository(localPreview(request)),
        actor,
        decodeURIComponent(spaceMatch[1]),
        request.headers.get("x-holy-workspace") || request.nextUrl.searchParams.get("workspace"),
      );
      return NextResponse.json(found, { headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } });
    } catch {
      return unavailableSpace();
    }
  }
  const match = request.nextUrl.pathname.match(/^\/s\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return NextResponse.next();
  try {
    const actor = await authenticate(request);
    const result = await resolvePublishedPage(await repository(localPreview(request)), actor, {
      workspaceId: request.headers.get("x-holy-workspace") || request.nextUrl.searchParams.get("workspace"),
      spaceSlug: decodeURIComponent(match[1]),
      pageSlug: decodeURIComponent(match[2]),
    });
    if (result.kind === "redirect") {
      const destination = new URL(result.location, request.url);
      const workspace = request.nextUrl.searchParams.get("workspace");
      if (workspace) destination.searchParams.set("workspace", workspace);
      return NextResponse.redirect(destination, 301);
    }
  } catch { /* The page renders the same generic not-found for hidden, missing and foreign slugs. */ }
  return NextResponse.next();
}

export const config = { matcher: ["/s/:path*"] };
