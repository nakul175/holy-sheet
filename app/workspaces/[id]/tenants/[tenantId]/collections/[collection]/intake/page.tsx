import RecordIntake from '../../../../../../../../components/record-intake';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string;collection:string}>}){
 const {id,tenantId,collection}=await params;
 return <RecordIntake key={`${id}:${tenantId}:${collection}`} workspaceId={id} tenantId={tenantId} collection={collection}/>;
}
