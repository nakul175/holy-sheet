import RecordTemplates from '../../../../../../../../components/record-templates';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string;collection:string}>}){
 const {id,tenantId,collection}=await params;
 return <RecordTemplates key={`${id}:${tenantId}:${collection}`} workspaceId={id} tenantId={tenantId} collection={collection}/>;
}
