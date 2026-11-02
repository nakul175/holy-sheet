import { authenticate, localPreview, readJson, sameOrigin, type Actor } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import { publishedNotFoundResponse, publishedRedirectResponse, resolvePublishedPage, restorePublishedPage } from "../../../../../../lib/published-pages";
import { z } from "zod";

type Context = { params: Promise<{ space: string; slug: string }> };
const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };

function workspaceId(request: Request) {
  const url = new URL(request.url);
  return request.headers.get("x-holy-workspace") || url.searchParams.get("workspace") || null;
}

async function handle(request: Request, mutation: boolean, fn: (actor: Actor) => Promise<unknown>) {
  try {
    if (mutation) sameOrigin(request);
    const actor = await authenticate(request);
    const result = await fn(actor);
    if (result instanceof Response) return result;
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
    console.error("HS published page request failed", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Service temporarily unavailable", code: "service_unavailable", retryable: true }, { status: 503, headers });
  }
}

export async function GET(request: Request, { params }: Context) {
  return handle(request, false, async actor => {
    const { space, slug } = await params;
    const result = await resolvePublishedPage(await repository(localPreview(request)), actor, { workspaceId: workspaceId(request), spaceSlug: space, pageSlug: slug });
    if (result.kind === "missing") return publishedNotFoundResponse();
    if (result.kind === "redirect") return publishedRedirectResponse(request, result.location);
    return result;
  });
}

const restore = z.object({ action: z.literal("restore"), operationId: z.string().uuid() }).strict();

export async function POST(request: Request, { params }: Context) {
  return handle(request, true, async actor => {
    const { space, slug } = await params;
    const body = restore.safeParse(await readJson(request, 4_000));
    if (!body.success) throw new DocumentError("Page not found", "not_found", 404);
    const r = await repository(localPreview(request));
    const result = await resolvePublishedPage(r, actor, { workspaceId: workspaceId(request), spaceSlug: space, pageSlug: slug });
    if (result.kind !== "trashed") return publishedNotFoundResponse();
    await restorePublishedPage(r, actor, result.pageId, body.data.operationId);
    const restored = await resolvePublishedPage(r, actor, { workspaceId: workspaceId(request), spaceSlug: space, pageSlug: slug });
    if (restored.kind === "missing") return publishedNotFoundResponse();
    if (restored.kind === "redirect") return publishedRedirectResponse(request, restored.location);
    return restored;
  });
}
