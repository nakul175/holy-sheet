import ContractChanges from "../../../../../../components/contract-changes";

export default async function Page({ params }: { params: Promise<{ id: string; tenantId: string }> }) {
  const { id, tenantId } = await params;
  return <ContractChanges workspaceId={id} tenantId={tenantId} />;
}
