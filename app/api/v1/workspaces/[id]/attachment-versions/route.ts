import { api, localPreview } from "../../../../../../lib/auth";
import { getAttachmentVersions, postAttachmentVersions } from "../../../../../../lib/attachment-version-http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => getAttachmentVersions(request, actor, (await params).id, localPreview(request)));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => postAttachmentVersions(request, actor, (await params).id, localPreview(request)), true);
}
