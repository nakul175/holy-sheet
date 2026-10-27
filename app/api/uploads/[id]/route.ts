import { api, localPreview, readBytes } from "../../../../lib/auth";
import { finishMedia, startMedia, cancelMedia,uploadState,renewUpload } from "../../../../lib/media";
import { repository } from "../../../../lib/repository";
export async function PUT(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const r=await repository(localPreview(req)),id=(await params).id;await startMedia(r,actor,id);return finishMedia(r,actor,id,await readBytes(req));},true);}
export async function DELETE(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>cancelMedia(await repository(localPreview(req)),actor,(await params).id),true);}
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>uploadState(await repository(localPreview(req)),actor,(await params).id));}
export async function PATCH(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>renewUpload(await repository(localPreview(req)),actor,(await params).id),true);}
