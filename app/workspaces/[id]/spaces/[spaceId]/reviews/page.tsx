import SpaceReviews from "../../../../../../components/space-reviews";

export default async function Page({ params }: { params: Promise<{ id: string; spaceId: string }> }) {
  const { id, spaceId } = await params;
  return <SpaceReviews workspaceId={id} spaceId={spaceId} />;
}
