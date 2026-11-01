import { authenticate, localPreview } from "../../../../../../../lib/auth";
import { attachmentDeniedResponse, downloadAttachment } from "../../../../../../../lib/attachment-version-http";
import { DocumentError } from "../../../../../../../lib/document";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  try {
    const actor = await authenticate(request);
    const route = await params;
    return await downloadAttachment(request, actor, route.id, route.token, localPreview(request));
  } catch (error) {
    if (error instanceof DocumentError) return attachmentDeniedResponse(error);
    console.error("HS attachment download failed", error instanceof Error ? error.name : "UnknownError");
    return attachmentDeniedResponse(new DocumentError("This item is restricted or unavailable.", "not_found", 404));
  }
}
