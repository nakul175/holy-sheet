import {z} from 'zod';
import {api,localPreview,readBytes} from '../../../../lib/auth';
import {repository} from '../../../../lib/repository';
import {prepareImport} from '../../../../lib/document-imports';
import {DocumentError} from '../../../../lib/document';
export const maxDuration=30;
const schema=z.object({id:z.string().uuid(),spaceId:z.string().min(1).max(200),title:z.string().min(1).max(240),filename:z.string().min(1).max(180)}).strict();
export async function POST(req:Request){return api(req,async actor=>{let metadata:unknown;const header=req.headers.get('x-hs-import')??'';if(!header||header.length>4096||!/^[A-Za-z0-9_-]+$/.test(header))throw new DocumentError('Import metadata is required.');try{metadata=JSON.parse(Buffer.from(header,'base64url').toString('utf8'));}catch{throw new DocumentError('Invalid import metadata.');}const parsed=schema.safeParse(metadata);if(!parsed.success)throw new DocumentError('Choose a title, destination and supported source file.');if(req.headers.get('content-type')?.split(';')[0]!=='application/octet-stream')throw new DocumentError('Send one binary source file.','import_type');return prepareImport(await repository(localPreview(req)),actor,parsed.data,await readBytes(req,20*1024*1024));},true);}
