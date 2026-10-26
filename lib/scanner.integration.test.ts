import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createDatabase,type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { scanBytes,reserveMedia,finishMedia,mediaAccess,getObject } from './media';
import { maintainStorage } from './maintenance';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Explicit opt-in: real loopback ClamAV, private local objects, isolated in-memory SQL.
const port=process.env.HS_TEST_CLAMAV_PORT;
let db:Database,r:Repository;
const clean=new TextEncoder().encode('Holy Sheet clean scanner acceptance fixture.');
const eicar=new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$'+'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
describe.skipIf(!port)('real isolated ClamAV acceptance',()=>{
 it('rejects a password-protected archive using the deployed scanner policy',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'holy-sheet-scan-'));try{const file=path.join(directory,'clean.txt'),archive=path.join(directory,'encrypted.zip');await writeFile(file,clean);await promisify(execFile)('zip',['-j','-P','acceptance',archive,file]);await expect(scanBytes(await readFile(archive))).rejects.toMatchObject({code:'unsafe_file'});}finally{await rm(directory,{recursive:true,force:true});}});
 it('keeps an unscanned upload quarantined and permits the same operation to retry when scanning returns',async()=>{const p=await r.create(localActor,'Scanner outage fixture','space-product'),upload=await reserveMedia(r,localActor,p.id,{operationId:crypto.randomUUID(),name:'outage.txt',size:clean.length});try{vi.stubEnv('CLAMAV_HOST','');await expect(finishMedia(r,localActor,upload.id,clean)).rejects.toMatchObject({code:'scanner_unavailable'});await expect(mediaAccess(r,localActor,upload.id)).rejects.toMatchObject({status:404});vi.stubEnv('CLAMAV_HOST','127.0.0.1');expect((await finishMedia(r,localActor,upload.id,clean)).state).toBe('ready');}finally{vi.stubEnv('CLAMAV_HOST','127.0.0.1');await db.query("UPDATE hs_media SET state='rejected' WHERE id=$1",[upload.id]);await maintainStorage(r);}});
 beforeAll(async()=>{if(port!=='57310')throw new Error('Use the dedicated loopback scanner acceptance port');vi.stubEnv('CLAMAV_HOST','127.0.0.1');vi.stubEnv('CLAMAV_PORT',port!);vi.stubEnv('S3_BUCKET','');db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();});
 afterAll(async()=>{await db?.close();vi.unstubAllEnvs();});
 it('accepts clean bytes and rejects the standard antivirus test signature',async()=>{await expect(scanBytes(clean)).resolves.toBeUndefined();await expect(scanBytes(eicar)).rejects.toMatchObject({code:'unsafe_file'});});
 it('activates clean uploads only after the real scanner acknowledges them',async()=>{const p=await r.create(localActor,'Clean scanner fixture','space-product'),upload=await reserveMedia(r,localActor,p.id,{operationId:crypto.randomUUID(),name:'clean.txt',size:clean.length});try{expect((await finishMedia(r,localActor,upload.id,clean)).state).toBe('ready');expect((await mediaAccess(r,localActor,upload.id)).state).toBe('ready');const row=(await db.query<{object_key:string;scanned_at:string}>('SELECT object_key,scanned_at FROM hs_media WHERE id=$1',[upload.id])).rows[0];expect(row.scanned_at).toBeTruthy();expect(new Uint8Array(await getObject(row.object_key))).toEqual(clean);}finally{await db.query("UPDATE hs_media SET state='rejected' WHERE id=$1",[upload.id]);await maintainStorage(r);}});
 it('keeps infected uploads unavailable and cleans their private bytes without retention delay',async()=>{const p=await r.create(localActor,'Rejected scanner fixture','space-product'),upload=await reserveMedia(r,localActor,p.id,{operationId:crypto.randomUUID(),name:'antivirus-test.txt',size:eicar.length});try{await expect(finishMedia(r,localActor,upload.id,eicar)).rejects.toMatchObject({code:'unsafe_file'});await expect(mediaAccess(r,localActor,upload.id)).rejects.toMatchObject({status:404});expect((await db.query<{state:string}>('SELECT state FROM hs_media WHERE id=$1',[upload.id])).rows[0].state).toBe('rejected');expect((await maintainStorage(r)).removed).toBe(1);expect((await db.query<{state:string}>('SELECT state FROM hs_media WHERE id=$1',[upload.id])).rows[0].state).toBe('purged');}finally{await db.query("UPDATE hs_media SET state='rejected' WHERE id=$1 AND state!='purged'",[upload.id]);await maintainStorage(r);}});
});
