import RecordBrowser from '../../../../../../components/record-browser';
export default async function Page({params}:{params:Promise<{id:string;tenantId:string}>}){const {id,tenantId}=await params;return <RecordBrowser workspaceId={id} tenantId={tenantId}/>;}
