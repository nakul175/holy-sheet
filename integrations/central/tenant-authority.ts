import {DatabaseSync} from 'node:sqlite';
import {createHash,timingSafeEqual} from 'node:crypto';
import {isAbsolute} from 'node:path';

type Context={subject:string;tenantId:string;workspaceId:string};
type Row=Record<string,string|number|null>;
export type TenantProof={active:true;subject:string;tenantId:string;workspaceId:string;tenantAdministrator:boolean;revision:string}|{active:false};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest=(s:string)=>createHash('sha256').update(s).digest();
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(digest(a),digest(b));
export class TenantAuthorityUnavailable extends Error{constructor(){super('Tenant authority is unavailable.');}}

/** Runs in Accounts, beside the provider's existing current-session verifier.
 * This reader never creates a file/schema, changes a role or infers identity
 * from an email, global role, workspace role or AdminScope delegation. */
export class DirectoryTenantAuthority{
 constructor(readonly file:string,readonly issuer:string){
  try{const url=new URL(issuer);if(!isAbsolute(file)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error();}catch{throw new TenantAuthorityUnavailable();}
 }
 verifyApplication(subjectId:string):{active:true;subject:string;revision:string}|{active:false}{
  if(typeof subjectId!=='string'||!subjectId||subjectId.length>200)return {active:false};
  let db:DatabaseSync|undefined;
  try{
   db=new DatabaseSync(this.file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN');
   const query=(sql:string,...params:string[])=>db!.prepare(sql).all(...params) as Row[];
   const subject=query('SELECT e.person_id,p.status FROM directory_externalsubject e JOIN directory_person p ON p.id=e.person_id WHERE e.issuer=? AND e.subject=?',this.issuer,subjectId);
   if(subject.length!==1||subject[0].status!=='active')return {active:false};
   const person=String(subject[0].person_id),access=query("SELECT a.id,a.organisation_id,a.status,m.status AS membership_status FROM directory_applicationaccess a JOIN directory_organisationmember m ON m.organisation_id=a.organisation_id AND m.person_id=a.person_id WHERE a.person_id=? AND a.application='holy-sheet' AND a.status='active' AND m.status='active'",person);
   if(!access.length)return {active:false};
   const revision=createHash('sha256').update(JSON.stringify({issuer:this.issuer,subject:subjectId,identity:subject,access})).digest('hex');
   db.exec('COMMIT');return {active:true,subject:subjectId,revision};
  }catch{throw new TenantAuthorityUnavailable();}finally{db?.close();}
 }
 verify(context:Context):TenantProof{
  if(!context||typeof context.subject!=='string'||!context.subject||context.subject.length>200||!uuid.test(context.tenantId)||typeof context.workspaceId!=='string'||!context.workspaceId||context.workspaceId.length>200)return {active:false};
  let db:DatabaseSync|undefined;
  try{
   db=new DatabaseSync(this.file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN');
   const query=(sql:string,...params:string[])=>db!.prepare(sql).all(...params) as Row[];
   const connector=query('SELECT application,mode,baseline_id,permission_contract_sha256,parity_verified_at,revocation_verified_at FROM directory_connectorstate WHERE application=?','holy-sheet');
   if(connector.length!==1||connector[0].mode!=='central'||!connector[0].parity_verified_at||!connector[0].revocation_verified_at||!/^([a-f0-9]{64})$/.test(String(connector[0].permission_contract_sha256)))return {active:false};
   const baseline=query('SELECT id,restore_verified FROM directory_snapshot WHERE id=?',String(connector[0].baseline_id));
   if(baseline.length!==1||baseline[0].restore_verified!==1)return {active:false};
   const subject=query('SELECT e.id,e.person_id,p.status FROM directory_externalsubject e JOIN directory_person p ON p.id=e.person_id WHERE e.issuer=? AND e.subject=?',this.issuer,context.subject);
   if(subject.length!==1||subject[0].status!=='active')return {active:false};
   // Django UUIDField values in SQLite are stored without hyphens.
   const tenant=context.tenantId.replaceAll('-',''),person=String(subject[0].person_id);
   const organisation=query('SELECT id FROM directory_organisation WHERE id=?',tenant);
   const membership=query('SELECT id,status FROM directory_organisationmember WHERE organisation_id=? AND person_id=?',tenant,person);
   const access=query('SELECT id,status FROM directory_applicationaccess WHERE organisation_id=? AND person_id=? AND application=?',tenant,person,'holy-sheet');
   const mapping=query('SELECT id,organisation_id,review_reference FROM directory_resourcemapping WHERE application=? AND resource_type=? AND resource_id=?','holy-sheet','workspace',context.workspaceId);
   if(organisation.length!==1||membership.length!==1||membership[0].status!=='active'||access.length!==1||access[0].status!=='active'||mapping.length!==1||mapping[0].organisation_id!==tenant||!String(mapping[0].review_reference??'').trim())return {active:false};
   const administrator=query('SELECT id,active,version,review_reference,updated_at FROM directory_tenantadministrator WHERE organisation_id=? AND person_id=? AND application=?',tenant,person,'holy-sheet');
   if(administrator.length>1)throw new TenantAuthorityUnavailable();
   const role=administrator[0],tenantAdministrator=!!role&&role.active===1&&Number.isSafeInteger(role.version)&&Number(role.version)>0&&!!String(role.review_reference??'').trim();
   const revision=createHash('sha256').update(JSON.stringify({issuer:this.issuer,context,connector,baseline,subject,organisation,membership,access,mapping,administrator})).digest('hex');
   db.exec('COMMIT');return {active:true,...context,tenantAdministrator,revision};
  }catch{throw new TenantAuthorityUnavailable();}finally{db?.close();}
 }
}

type Session={active:boolean;sub?:string;local_id?:string};
type Reply={status(code:number):Reply;json(body:unknown):unknown;set(headers:Record<string,string>):unknown};
export type TenantHandlerOptions={enabled:boolean;issuer:string;directoryFile?:string;clients:readonly{client_id:string;client_secret:string}[];verifySession(clientId:string,subject:string,uid:string):Promise<Session>};
/** Install only with express.json({limit:'4kb'}) and Accounts' HTTPS guard.
 * Authentication secrets/session identifiers are POST-body-only and never
 * appear in returned proofs, errors, logs or URL query strings. */
export function tenantStatusHandler(options:TenantHandlerOptions){
 return async(req:{body?:unknown},res:Reply)=>{
  res.set({'Cache-Control':'no-store','Pragma':'no-cache','Vary':'Authorization'});
  const body=req.body as Record<string,unknown>|undefined;
  if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({error:'invalid_request'});
  const client=options.clients.find(c=>c.client_id==='holy-sheet'&&c.client_id===body.client_id);
  if(!client||client.client_secret.length<32||!same(client.client_secret,body.client_secret))return res.status(401).json({error:'invalid_client'});
  const {sub,uid,tenant_id,workspace_id}=body;
  if(Object.keys(body).some(k=>!['client_id','client_secret','sub','uid','tenant_id','workspace_id'].includes(k))||typeof sub!=='string'||!sub||sub.length>200||typeof uid!=='string'||!uid||uid.length>200||typeof tenant_id!=='string'||!uuid.test(tenant_id)||typeof workspace_id!=='string'||!workspace_id||workspace_id.length>200)return res.status(400).json({error:'invalid_request'});
  if(!options.enabled||!options.directoryFile)return res.status(503).json({error:'tenant_authority_unavailable'});
  const sessionActive=async()=>{const s=await options.verifySession('holy-sheet',sub,uid);return s.active===true&&s.sub===sub&&s.local_id===sub;};
  try{
   if(!await sessionActive())return res.json({active:false});
   const directory=new DirectoryTenantAuthority(options.directoryFile,options.issuer),context={subject:sub,tenantId:tenant_id,workspaceId:workspace_id};
   const proof=directory.verify(context);
   if(!await sessionActive())return res.json({active:false});
   const final=directory.verify(context);
   if(!proof.active||!final.active)return res.json({active:false});
   if(final.revision!==proof.revision)return res.status(409).json({error:'tenant_authority_changed'});
   return res.json(final);
  }catch{return res.status(503).json({error:'tenant_authority_unavailable'});}
 };
}

export function applicationStatusHandler(options:TenantHandlerOptions){
 return async(req:{body?:unknown},res:Reply)=>{
  res.set({'Cache-Control':'no-store','Pragma':'no-cache','Vary':'Authorization'});
  const body=req.body as Record<string,unknown>|undefined;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['client_id','client_secret','sub','uid'].includes(k)))return res.status(400).json({error:'invalid_request'});
  const client=options.clients.find(c=>c.client_id==='holy-sheet'&&c.client_id===body.client_id);
  if(!client||client.client_secret.length<32||!same(client.client_secret,body.client_secret))return res.status(401).json({error:'invalid_client'});
  const {sub,uid}=body;if(typeof sub!=='string'||!sub||sub.length>200||typeof uid!=='string'||!uid||uid.length>200)return res.status(400).json({error:'invalid_request'});
  if(!options.enabled||!options.directoryFile)return res.status(503).json({error:'application_authority_unavailable'});
  try{
   const session=await options.verifySession('holy-sheet',sub,uid);if(session.active!==true||session.sub!==sub||session.local_id!==sub)return res.json({active:false});
   const directory=new DirectoryTenantAuthority(options.directoryFile,options.issuer),first=directory.verifyApplication(sub);if(!first.active)return res.json({active:false});
   const sessionAfter=await options.verifySession('holy-sheet',sub,uid);if(sessionAfter.active!==true||sessionAfter.sub!==sub||sessionAfter.local_id!==sub)return res.json({active:false});
   const final=directory.verifyApplication(sub);if(!final.active)return res.json({active:false});if(final.revision!==first.revision)return res.status(409).json({error:'application_authority_changed'});return res.json(final);
  }catch{return res.status(503).json({error:'application_authority_unavailable'});}
 };
}
