import PageHandover from "../../../../components/page-handover";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PageHandover workspaceId={id} />;
}
