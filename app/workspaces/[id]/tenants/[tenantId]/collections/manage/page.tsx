import CollectionManager from '../../../../../../../components/collection-manager';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string}>}){const {id,tenantId}=await params;return <CollectionManager workspaceId={id} tenantId={tenantId}/>;}
