import { api, localPreview } from "../../../../lib/auth";
import { mediaAccess, getObject } from "../../../../lib/media";
import { repository } from "../../../../lib/repository";
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{
  const r=await repository(localPreview(req)),m=await mediaAccess(r,actor,(await params).id),bytes=await getObject(m.object_key);
  // Recheck after object retrieval; revocation while storage was responding must not authorize delivery.
  await r.access(r.db,m.page_id,actor);
  const headers=new Headers({"Content-Type":m.mime,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox","Cache-Control":"private, no-store","Vary":"Cookie, Authorization","Accept-Ranges":"bytes","Content-Disposition":`${m.mime.startsWith("image/")?"inline":"attachment"}; filename="download"; filename*=UTF-8''${encodeURIComponent(m.name).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`});
  const range=req.headers.get("range");let start=0,end=bytes.length-1,status=200;
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{"Content-Range":`bytes */${bytes.length}`,"Cache-Control":"no-store"}});if(!match[1])start=Math.max(0,bytes.length-Number(match[2]));else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(start>end||start>=bytes.length)return new Response(null,{status:416,headers:{"Content-Range":`bytes */${bytes.length}`,"Cache-Control":"no-store"}});status=206;headers.set("Content-Range",`bytes ${start}-${end}/${bytes.length}`);}
  headers.set("Content-Length",String(end-start+1));return new Response(new Uint8Array(bytes.slice(start,end+1)),{status,headers});
});}
