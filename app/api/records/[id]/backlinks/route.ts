import { authenticate, localPreview } from "../../../../../lib/auth";
import { DocumentError } from "../../../../../lib/document";
import { parseRecordBacklinkQuery, readRecordBacklinks } from "../../../../../lib/record-backlinks";
import { repository } from "../../../../../lib/repository";

const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await authenticate(request);
    const { id } = await context.params;
    const query = parseRecordBacklinkQuery(new URL(request.url));
    const result = await readRecordBacklinks(await repository(localPreview(request)), actor, id, query);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
    console.error("HS record backlink request failed", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
  }
}
