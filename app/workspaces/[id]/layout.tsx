import type {ReactNode} from 'react';
import LaptopWorkspace from '../../../components/laptop-workspace';
export default async function Layout({children,params}:{children:ReactNode;params:Promise<{id:string}>}){
 const {id}=await params;
 return <LaptopWorkspace key={id} workspaceId={id}>{children}</LaptopWorkspace>;
}
