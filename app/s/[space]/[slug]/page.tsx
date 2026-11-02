import type { Metadata } from "next";
import { headers } from "next/headers";
import { permanentRedirect } from "next/navigation";
import StablePublishedPage from "../../../../components/published-page";
import { authenticate, localPreview } from "../../../../lib/auth";
import { DocumentError } from "../../../../lib/document";
import { repository } from "../../../../lib/repository";
import { publishedDocumentMetadata, resolvePublishedPage, type PublishedResolution } from "../../../../lib/published-pages";

type RouteParams = { params: Promise<{ space: string; slug: string }>; searchParams: Promise<{ workspace?: string }> };

async function load(space: string, slug: string, workspace: string | undefined): Promise<PublishedResolution> {
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const request = new Request(`${proto}://${host}/s/${encodeURIComponent(space)}/${encodeURIComponent(slug)}`, { headers: headerList });
  try {
    const actor = await authenticate(request);
    return await resolvePublishedPage(await repository(localPreview(request)), actor, {
      workspaceId: headerList.get("x-holy-workspace") || workspace || null,
      spaceSlug: space,
      pageSlug: slug,
    });
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 401 || error.status === 403)) return { kind: "missing" };
    throw error;
  }
}

export async function generateMetadata({ params, searchParams }: RouteParams): Promise<Metadata> {
  const { space, slug } = await params;
  const query = await searchParams;
  return publishedDocumentMetadata(await load(space, slug, query.workspace));
}

export default async function Page({ params, searchParams }: RouteParams) {
  const { space, slug } = await params;
  const query = await searchParams;
  const result = await load(space, slug, query.workspace);
  if (result.kind === "redirect") permanentRedirect(result.location);
  return <StablePublishedPage initial={result} space={space} slug={slug} workspaceId={query.workspace ?? ""} />;
}
