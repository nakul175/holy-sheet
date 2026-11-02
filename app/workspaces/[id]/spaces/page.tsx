import SpaceDirectory from "../../../../components/space-directory";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ archived?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  return <SpaceDirectory workspaceId={id} includeArchivedInitially={query.archived === "1"} />;
}
