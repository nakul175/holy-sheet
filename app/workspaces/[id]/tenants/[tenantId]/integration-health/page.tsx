import IntegrationHealth from "../../../../../../components/integration-health";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string; tenantId: string }>; searchParams: Promise<{ collection?: string }> }) {
  const { id, tenantId } = await params;
  const query = await searchParams;
  const collection = typeof query.collection === "string" && query.collection ? query.collection : "organisations";
  return <IntegrationHealth workspaceId={id} tenantId={tenantId} collection={collection} />;
}
