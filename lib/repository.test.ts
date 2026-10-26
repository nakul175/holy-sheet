import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { localActor, authenticate, sameOrigin } from "./auth";
import { ensureIds, plainText, type RichNode } from "./document";
import { draftKey } from "./drafts";
import { maintainStorage } from "./maintenance";
import { mediaPolicy, reserveMedia, scanBytes, validateMediaBytes, validateMediaMetadata } from "./media";

let db:Database,r:Repository;
const owner=localActor,editor={id:'editor'},viewer={id:'viewer'},outsider={id:'outsider'};
const body=(text:string):RichNode=>ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
beforeAll(async()=>{db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();for(const actor of [editor,viewer,outsider]){await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[actor.id]);await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[actor.id]);}});
afterAll(async()=>{await db.close();});
async function fixture(){const p=await r.create(owner,'Test page','space-product');await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,'editor','editor'),($1,'viewer','viewer')",[p.id]);return p;}
const operation=(p:{version:number},text:string)=>({operationId:crypto.randomUUID(),baseVersion:p.version,title:'Test page',document:body(text)});
describe('authorized transactional persistence',()=>{
  it('starts from a durable SQL-backed welcome document',async()=>{const p=await r.get('welcome',owner);expect(p.document.content?.length).toBe(3);expect(p.role).toBe('owner');});
  it('reads grants, rejects viewer writes and does not reveal private pages',async()=>{const p=await fixture();expect((await r.get(p.id,viewer)).role).toBe('viewer');await expect(r.save(p.id,viewer,operation(p,'no'))).rejects.toMatchObject({status:403});await expect(r.get(p.id,outsider)).rejects.toMatchObject({status:404});expect((await r.list(outsider)).some(x=>x.id===p.id)).toBe(false);});
  it('checks membership even for a page owner and ignores mere space membership',async()=>{const p=await fixture();await db.query("UPDATE hs_members SET active=false WHERE user_id='editor'");await expect(r.get(p.id,editor)).rejects.toMatchObject({status:404});await db.query("UPDATE hs_members SET active=true WHERE user_id='editor'");});
  it('rejects invalid creation instead of falling back to another space',async()=>{await expect(r.create(owner,'Invalid','missing')).rejects.toMatchObject({status:404});});
  it('saves rich structure and stable IDs, then reads an independent copy',async()=>{const p=await fixture(),op=operation(p,'Persisted 👋');const result=await r.save(p.id,editor,op);const reopened=await r.get(p.id,viewer);expect(reopened.version).toBe(2);expect(reopened.document).toEqual(result.page.document);expect(reopened.document.content![0].attrs!.id).toBe(op.document.content![0].attrs!.id);expect(plainText(reopened.document)).toBe('Persisted 👋');});
  it('replays a lost acknowledgement without applying the operation twice or losing a later writer',async()=>{const p=await fixture(),a=operation(p,'First');await r.save(p.id,editor,a);const second=await r.get(p.id,owner);await r.save(p.id,owner,{...operation(second,'Second'),title:'Second title',document:second.document});const replay=await r.save(p.id,editor,a);expect(replay.replayed).toBe(true);expect(replay.committedVersion).toBe(2);expect(replay.page.version).toBe(3);});
  it('acknowledges unchanged saves without creating a misleading content revision',async()=>{const p=await fixture(),op={operationId:crypto.randomUUID(),baseVersion:p.version,title:p.title,document:p.document};const result=await r.save(p.id,owner,op);expect(result.page.version).toBe(p.version);expect((await r.save(p.id,owner,op)).replayed).toBe(true);const revisions=await db.query<{count:number}>('SELECT count(*)::integer AS count FROM hs_revisions WHERE page_id=$1',[p.id]);expect(revisions.rows[0].count).toBe(1);});
  it('rejects operation ID reuse with a different payload',async()=>{const p=await fixture(),op=operation(p,'One');await r.save(p.id,owner,op);await expect(r.save(p.id,owner,{...op,title:'Changed'})).rejects.toMatchObject({code:'operation_mismatch'});expect((await r.get(p.id,owner)).version).toBe(2);});
  it('merges distinct content-only edits against the actual stored base',async()=>{const p=await fixture();const d=body('A');d.content!.push(...body('B').content!);await r.save(p.id,owner,{...operation(p,''),document:d});const base=await r.get(p.id,owner),a=structuredClone(base.document),b=structuredClone(base.document);a.content![0].content![0].text='Remote';b.content![1].content![0].text='Local';await r.save(p.id,owner,{...operation(base,''),document:a});const result=await r.save(p.id,editor,{...operation(base,''),document:b});expect(result.merged).toBe(true);expect(plainText(result.page.document)).toBe('Remote\nLocal');});
  it('keeps the server unchanged for same-block and structural conflicts',async()=>{const p=await fixture();await r.save(p.id,owner,operation(p,'Base'));const base=await r.get(p.id,owner),a=structuredClone(base.document),b=structuredClone(base.document);a.content![0].content![0].text='Remote';b.content![0].content![0].text='Local';await r.save(p.id,owner,{...operation(base,''),document:a});await expect(r.save(p.id,editor,{...operation(base,''),document:b})).rejects.toMatchObject({code:'conflict'});expect(plainText((await r.get(p.id,owner)).document)).toBe('Remote');});
  it('rejects invalid documents atomically and preserves previous revision',async()=>{const p=await fixture(),d=body('Duplicate');d.content!.push(structuredClone(d.content![0]));await expect(r.save(p.id,owner,{...operation(p,''),document:d})).rejects.toThrow('duplicate');expect((await r.get(p.id,owner)).version).toBe(1);});
  it('revocation is authoritative on retries as well as new saves',async()=>{const p=await fixture(),op=operation(p,'Saved');await r.save(p.id,editor,op);await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject='editor'",[p.id]);await expect(r.save(p.id,editor,op)).rejects.toMatchObject({status:404});});
});
describe('private recovery keys',()=>{
  it('binds keys to the exact actor/page/draft and denies revoked readers',async()=>{const p=await fixture(),id=crypto.randomUUID();const a=await draftKey(r,editor,p.id,{id});const again=await draftKey(r,editor,p.id,{id});expect(again.key).toBe(a.key);const q=await fixture();await expect(draftKey(r,editor,q.id,{id})).rejects.toMatchObject({status:404});await expect(draftKey(r,viewer,p.id,{id})).rejects.toMatchObject({status:404});await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject='editor'",[p.id]);await expect(draftKey(r,editor,p.id,{id})).rejects.toMatchObject({status:404});});
  it('does not renew on read and refuses expired drafts',async()=>{const p=await fixture(),id=crypto.randomUUID();const a=await draftKey(r,owner,p.id,{id}),b=await draftKey(r,owner,p.id,{id});expect(a.expiresAt).toBe(b.expiresAt);await db.query("UPDATE hs_drafts SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);await expect(draftKey(r,owner,p.id,{id})).rejects.toMatchObject({code:'draft_expired'});});
});
describe('upload policy and reservations',()=>{
  it('enforces decimal byte boundaries and rejects unapproved formats',()=>{expect(validateMediaMetadata('photo.png',10_000_000).mime).toBe('image/png');expect(()=>validateMediaMetadata('photo.png',10_000_001)).toThrow('10 MB');expect(()=>validateMediaMetadata('file.docm',1)).toThrow();expect(()=>validateMediaMetadata('x.svg',1)).toThrow();expect(mediaPolicy.pageBytes).toBe(100_000_000);});
  it('rejects disguised executables and binary bytes in text before activation',async()=>{await expect(validateMediaBytes('sample.pdf',new TextEncoder().encode('MZ executable'))).rejects.toThrow('bytes');await expect(validateMediaBytes('sample.txt',new Uint8Array([65,0,66]))).rejects.toThrow('Binary');});
  it('never treats unavailable scanning as approval',async()=>{const before=process.env.CLAMAV_HOST;delete process.env.CLAMAV_HOST;await expect(scanBytes(new Uint8Array([1]))).rejects.toMatchObject({code:'scanner_unavailable'});if(before)process.env.CLAMAV_HOST=before;});
  it('reserves quota atomically and deduplicates repeated attempts',async()=>{const p=await fixture();const first={operationId:crypto.randomUUID(),name:'one.txt',size:25_000_000};const a=await reserveMedia(r,owner,p.id,first),again=await reserveMedia(r,owner,p.id,first);expect(again.id).toBe(a.id);for(let i=0;i<2;i++)await reserveMedia(r,owner,p.id,{operationId:crypto.randomUUID(),name:`more${i}.txt`,size:25_000_000});const results=await Promise.allSettled([reserveMedia(r,owner,p.id,{operationId:crypto.randomUUID(),name:'race1.txt',size:25_000_000}),reserveMedia(r,owner,p.id,{operationId:crypto.randomUUID(),name:'race2.txt',size:25_000_000})]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);});
});
describe('request boundaries',()=>{
  it('requires exact same-origin intent for mutation',()=>{expect(()=>sameOrigin(new Request('http://localhost:3000/api/pages',{method:'POST',headers:{origin:'https://evil.example'}}))).toThrow();expect(()=>sameOrigin(new Request('http://localhost:3000/api/pages',{method:'POST',headers:{origin:'http://localhost:3000'}}))).not.toThrow();});
  it('uses the validated loopback Host in development without trusting forwarded origins',()=>{expect(()=>sameOrigin(new Request('http://localhost:3000/api/pages',{method:'POST',headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000'}}))).not.toThrow();expect(()=>sameOrigin(new Request('http://localhost:3000/api/pages',{method:'POST',headers:{host:'evil.example',origin:'https://evil.example','x-forwarded-host':'localhost:3000'}}))).toThrow();});
  it('does not permit local preview identity in production',async()=>{vi.stubEnv('NODE_ENV','production');try{await expect(authenticate(new Request('http://localhost:3000/api/pages'))).rejects.toMatchObject({code:'identity_unavailable'});}finally{vi.unstubAllEnvs();}});
});
describe('bounded media maintenance',()=>{
  it('preserves live references and recovery leases while retrying failed erasures',async()=>{
    const p=await fixture();
    const insert=async(state='ready')=>{const id=crypto.randomUUID();await db.query("INSERT INTO hs_media(id,page_id,uploader_id,operation_id,name,mime,size,object_key,state,created_at,scanned_at,deleted_at) VALUES($1,$2,$3,$4,'file.txt','text/plain',1,$6,$5,now(),now(),now()-interval '8 days')",[id,p.id,owner.id,crypto.randomUUID(),state,id]);return id;};
    const active=await insert(),leased=await insert(),expired=await insert();
    const document=ensureIds({type:'doc',content:[{type:'file',attrs:{attachmentId:active,title:'file.txt'}}]});
    await r.save(p.id,owner,{...operation(p,''),document});
    await draftKey(r,owner,p.id,{id:crypto.randomUUID(),attachmentIds:[leased]});
    await db.query("UPDATE hs_media SET created_at=now()-interval '10 days',scanned_at=now()-interval '10 days' WHERE page_id=$1",[p.id]);
    const erase=vi.fn(async(_key:string)=>{throw new Error('storage unavailable');});
    const first=await maintainStorage(r,erase);expect(first.failed).toBeGreaterThanOrEqual(1);expect(erase.mock.calls.some(call=>String(call[0])===active)).toBe(false);expect(erase.mock.calls.some(call=>String(call[0])===leased)).toBe(false);
    expect((await db.query<{state:string}>('SELECT state FROM hs_media WHERE id=$1',[expired])).rows[0].state).toBe('purging');
    const retry=vi.fn(async(_key:string)=>{});await maintainStorage(r,retry);expect(retry).toHaveBeenCalledWith(expired);expect((await db.query<{state:string}>('SELECT state FROM hs_media WHERE id=$1',[expired])).rows[0].state).toBe('purged');
  });
});
