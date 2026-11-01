import EffectiveDates from "../../../../../../components/effective-dates";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string; tenantId: string }>; searchParams: Promise<{ collection?: string }> }) {
  const { id, tenantId } = await params;
  const query = await searchParams;
  const collection = typeof query.collection === "string" && query.collection ? query.collection : "organisations";
  return <EffectiveDates workspaceId={id} tenantId={tenantId} collection={collection} />;
}
