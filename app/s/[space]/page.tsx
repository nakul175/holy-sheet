import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, localPreview } from "../../../lib/auth";
import { DocumentError } from "../../../lib/document";
import { repository } from "../../../lib/repository";
import { SPACE_UNAVAILABLE, readSpaceBySlug } from "../../../lib/space-directory";

export default async function Page({ params, searchParams }: { params: Promise<{ space: string }>; searchParams: Promise<{ workspace?: string }> }) {
  const { space } = await params;
  const query = await searchParams;
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const request = new Request(`${proto}://${host}/s/${encodeURIComponent(space)}`, { headers: headerList });
  try {
    const actor = await authenticate(request);
    const workspaceId = headerList.get("x-holy-workspace") || query.workspace || null;
    const found = await readSpaceBySlug(await repository(localPreview(request)), actor, space, workspaceId);
    redirect(`/workspaces/${encodeURIComponent(found.workspaceId)}/spaces/${encodeURIComponent(found.id)}`);
  } catch (error) {
    if (error instanceof DocumentError) {
      return <main className="space-directory"><h1>{SPACE_UNAVAILABLE}</h1></main>;
    }
    throw error;
  }
}
