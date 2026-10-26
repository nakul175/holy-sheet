import { api, localPreview } from "../../../lib/auth";
import { repository } from "../../../lib/repository";
import { searchPages } from "../../../lib/search";
export async function GET(req:Request){return api(req,async actor=>{const p=new URL(req.url).searchParams;const pages=await (await repository(localPreview(req))).list(actor);return {results:searchPages(pages,(p.get("q")??"").slice(0,512),p.get("spaceId")).slice(0,20)};});}
