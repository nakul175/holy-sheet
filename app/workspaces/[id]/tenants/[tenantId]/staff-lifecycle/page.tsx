import StaffLifecycle from "../../../../../../components/staff-lifecycle";

export default async function Page({ params }: { params: Promise<{ id: string; tenantId: string }> }) {
  const { id, tenantId } = await params;
  return <StaffLifecycle workspaceId={id} tenantId={tenantId} />;
}
