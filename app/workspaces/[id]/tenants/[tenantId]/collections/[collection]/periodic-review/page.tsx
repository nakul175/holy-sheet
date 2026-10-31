import RecordPeriodicReview from '../../../../../../../../components/record-periodic-review';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string;collection:string}>}){
 const {id,tenantId,collection}=await params;
 return <RecordPeriodicReview key={`${id}:${tenantId}:${collection}`} workspaceId={id} tenantId={tenantId} collection={collection}/>;
}
