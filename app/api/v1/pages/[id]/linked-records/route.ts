import { api, localPreview } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { getPageLinkedRecords, postPageLinkedRecord } from "../../../../../../lib/document-record-link-http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    if (cursor && cursor.length > 500) throw new DocumentError("Check the document link request.", "document_link_validation", 400);
    return getPageLinkedRecords(actor, (await params).id, cursor, localPreview(request));
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => postPageLinkedRecord(request, actor, (await params).id, localPreview(request)), true);
}
