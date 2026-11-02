import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, localPreview } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import { repository } from "../../../../../../../lib/repository";
import { SPACE_UNAVAILABLE, resolveSpacePage } from "../../../../../../../lib/space-directory";

export default async function Page({ params }: { params: Promise<{ id: string; spaceId: string; pageId: string }> }) {
  const { id, spaceId, pageId } = await params;
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const request = new Request(`${proto}://${host}/workspaces/${encodeURIComponent(id)}/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`, { headers: headerList });
  try {
    const actor = await authenticate(request);
    const result = await resolveSpacePage(await repository(localPreview(request)), actor, id, spaceId, pageId);
    redirect(result.location);
  } catch (error) {
    if (error instanceof DocumentError) {
      return <main className="space-directory"><h1>{SPACE_UNAVAILABLE}</h1></main>;
    }
    throw error;
  }
}
