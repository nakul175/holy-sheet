import { authenticate } from '../../../lib/auth';
import { DocumentError } from '../../../lib/document';
const headers={'Cache-Control':'no-store',Vary:'Cookie, Authorization'};
export async function GET(request:Request){try{const actor=await authenticate(request);return Response.json({authenticated:true,userId:actor.id},{headers});}catch(error){return Response.json({authenticated:false},{status:error instanceof DocumentError?error.status:503,headers});}}
