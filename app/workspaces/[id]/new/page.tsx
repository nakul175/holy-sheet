import {LaptopWorkspaceScreen} from "../../../../components/laptop-workspace";
export default async function Page({params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 return <LaptopWorkspaceScreen workspaceId={id} screen="new"/>;
}
