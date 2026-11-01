import SpaceHome from "../../../../../components/space-home";

export default async function Page({ params }: { params: Promise<{ id: string; spaceId: string }> }) {
  const { id, spaceId } = await params;
  return <SpaceHome workspaceId={id} spaceId={spaceId} />;
}
