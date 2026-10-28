import {startShoConnection} from '../../../../lib/sho-checklist-client';
export const GET=(req:Request)=>startShoConnection(new URL(req.url).searchParams.get('next')??'/pages/welcome');
