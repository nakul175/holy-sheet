import ConditionManager from '../../../../../../../../components/condition-manager';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string;collection:string}>}){const {id,tenantId,collection}=await params;return <ConditionManager workspaceId={id} tenantId={tenantId} collection={collection}/>;}
