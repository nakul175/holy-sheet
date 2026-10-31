import RecordQuality from '../../../../../../../../components/record-quality';
export default async function Page({params,searchParams}:{params:Promise<{id:string;tenantId:string;collection:string}>;searchParams:Promise<{record?:string|string[]}>}){
 const {id,tenantId,collection}=await params;
 const record=one((await searchParams).record);
 const recordId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record??'')?record:undefined;
 return <RecordQuality key={`${id}:${tenantId}:${collection}:${recordId??''}`} workspaceId={id} tenantId={tenantId} collection={collection} recordId={recordId}/>;
}
function one(value:string|string[]|undefined){return Array.isArray(value)?value[0]:value;}
