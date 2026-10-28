import {notFound} from 'next/navigation';import LayoutQualification from './preview';
export const dynamic='force-dynamic';
export default function Page(){if(process.env.HS_LOCAL_PREVIEW!=='1')notFound();return <LayoutQualification/>;}
