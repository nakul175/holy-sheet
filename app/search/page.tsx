import SearchScreen from '../../components/search-screen';
export default async function Page({searchParams}:{searchParams:Promise<{workspaceId?:string}>}){
 const {workspaceId}=await searchParams;
 return <SearchScreen initialWorkspaceId={typeof workspaceId==='string'?workspaceId:''}/>;
}
