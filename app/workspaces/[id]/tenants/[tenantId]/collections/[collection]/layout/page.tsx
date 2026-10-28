import LayoutManager from '../../../../../../../../components/layout-manager';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string;collection:string}>}){const {id,tenantId,collection}=await params;return <LayoutManager workspaceId={id} tenantId={tenantId} collection={collection}/>;}
