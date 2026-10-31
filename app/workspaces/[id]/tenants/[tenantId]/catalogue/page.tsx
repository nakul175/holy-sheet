import RecordCatalogue from '../../../../../../components/record-catalogue';
export default async function Page({params,searchParams}:{params:Promise<{id:string;tenantId:string}>;searchParams:Promise<{collection?:string|string[]}>}){
 const {id,tenantId}=await params;
 const collection=one((await searchParams).collection);
 const selected=collection&&collection.length<=100&&!/[\p{Cc}]/u.test(collection)?collection:undefined;
 return <RecordCatalogue key={`${id}:${tenantId}:${selected??''}`} workspaceId={id} tenantId={tenantId} collection={selected}/>;
}
function one(value:string|string[]|undefined){return Array.isArray(value)?value[0]:value;}
