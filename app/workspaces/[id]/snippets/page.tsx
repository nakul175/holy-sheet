import SnippetLibrary from "../../../../components/snippet-library";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ snippet?: string | string[] }> }) {
  const { id } = await params;
  const snippet = (await searchParams).snippet;
  const initialSnippetId = Array.isArray(snippet) ? snippet[0] : snippet;
  return <SnippetLibrary workspaceId={id} initialSnippetId={initialSnippetId} />;
}
