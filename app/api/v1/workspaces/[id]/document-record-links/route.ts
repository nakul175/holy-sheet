import { api, localPreview } from "../../../../../../lib/auth";
import { getWorkspaceDocumentLinks, postWorkspaceDocumentLink } from "../../../../../../lib/document-record-link-http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => getWorkspaceDocumentLinks(request, actor, (await params).id, localPreview(request)));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => postWorkspaceDocumentLink(request, actor, (await params).id, localPreview(request)), true);
}
