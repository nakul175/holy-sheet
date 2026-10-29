import ReferenceListManager from '../../../../../../components/reference-list-manager';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string}>}){const {id,tenantId}=await params;return <ReferenceListManager workspaceId={id} tenantId={tenantId}/>;}
