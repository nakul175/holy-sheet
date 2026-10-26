import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { changeSharing,sharingState } from './sharing';
let db:Database,r:Repository;
const owner=localActor,editor={id:'sharing-editor'},viewer={id:'sharing-viewer'},stranger={id:'sharing-outsider'};
beforeAll(async()=>{db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();for(const a of [editor,viewer,stranger]){await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[a.id]);if(a!==stranger)await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[a.id]);}});
afterAll(async()=>{await db.close();});
async function fixture(){const root=await r.create(owner,'Private ancestor','space-product'),child=await r.create(owner,'Shared branch','space-product',root.id),grandchild=await r.create(owner,'Nested document','space-product',child.id),sibling=await r.create(owner,'Private sibling','space-product',root.id);return {root,child,grandchild,sibling};}
async function grant(id:string,recipientId:string,role:'viewer'|'editor'|null){const s=await sharingState(r,owner,id);return changeSharing(r,owner,id,{operationId:crypto.randomUUID(),expectedVersion:s.version,recipientId,role});}
describe('HOLY-4 inherited sharing',()=>{
  it('shares existing and future descendants while hiding ancestors and siblings',async()=>{
    const f=await fixture();await grant(f.child.id,viewer.id,'viewer');expect((await r.get(f.grandchild.id,viewer)).role).toBe('viewer');expect((await r.get(f.child.id,viewer)).parentTitle).toBeNull();await expect(r.get(f.root.id,viewer)).rejects.toMatchObject({status:404});await expect(r.get(f.sibling.id,viewer)).rejects.toMatchObject({status:404});const future=await r.create(owner,'Future child','space-product',f.child.id);expect((await r.get(future.id,viewer)).role).toBe('viewer');const ids=(await r.list(viewer)).map(p=>p.id);expect(ids).toEqual(expect.arrayContaining([f.child.id,f.grandchild.id,future.id]));expect(ids).not.toContain(f.root.id);
  });
  it('takes the highest applicable grant, and reports remaining inherited access after direct removal',async()=>{
    const f=await fixture();await grant(f.child.id,editor.id,'editor');await grant(f.grandchild.id,editor.id,'viewer');expect((await r.get(f.grandchild.id,editor)).role).toBe('editor');const result=await grant(f.grandchild.id,editor.id,null);expect(result.effectiveRole).toBe('editor');expect((await sharingState(r,owner,f.grandchild.id)).inherited).toEqual(expect.arrayContaining([expect.objectContaining({recipientId:editor.id,role:'editor',sourceId:f.child.id})]));
  });
  it('allows editor content/subpage work and rejects editor/viewer sharing administration',async()=>{
    const f=await fixture();await grant(f.child.id,editor.id,'editor');await grant(f.child.id,viewer.id,'viewer');const p=await r.get(f.grandchild.id,editor);await r.save(p.id,editor,{operationId:crypto.randomUUID(),baseVersion:p.version,title:'Edited child',document:p.document});await r.create(editor,'Editor-created subpage','space-product',f.child.id);await expect(sharingState(r,editor,f.child.id)).rejects.toMatchObject({code:'owner_required'});await expect(changeSharing(r,viewer,f.child.id,{operationId:crypto.randomUUID(),expectedVersion:3,recipientId:stranger.id,role:'editor'})).rejects.toMatchObject({code:'owner_required'});await expect(r.create(viewer,'Denied','space-product',f.child.id)).rejects.toMatchObject({code:'read_only'});
  });
  it('revokes descendants immediately, while an independent direct grant continues to apply',async()=>{
    const f=await fixture();await grant(f.child.id,editor.id,'editor');await grant(f.grandchild.id,editor.id,'viewer');await grant(f.child.id,editor.id,null);await expect(r.get(f.child.id,editor)).rejects.toMatchObject({status:404});const p=await r.get(f.grandchild.id,editor);expect(p.role).toBe('viewer');await expect(r.save(p.id,editor,{operationId:crypto.randomUUID(),baseVersion:p.version,title:p.title,document:p.document})).rejects.toMatchObject({code:'read_only'});await grant(f.grandchild.id,editor.id,null);await expect(r.get(p.id,editor)).rejects.toMatchObject({status:404});
  });
  it('rejects cross-workspace/nonmember targets and protects ownership',async()=>{
    const f=await fixture();await expect(grant(f.child.id,stranger.id,'editor')).rejects.toMatchObject({code:'member_required'});await expect(grant(f.child.id,owner.id,'viewer')).rejects.toMatchObject({code:'owner_protected'});expect((await sharingState(r,owner,f.child.id)).version).toBe(1);
  });
  it('deduplicates retries and audits one before/after transition',async()=>{
    const f=await fixture(),op={operationId:crypto.randomUUID(),expectedVersion:1,recipientId:viewer.id,role:'viewer' as const};await changeSharing(r,owner,f.child.id,op);const replay=await changeSharing(r,owner,f.child.id,op);expect(replay.replayed).toBe(true);expect(replay.effectiveRole).toBe('viewer');const events=await db.query<{before_value:unknown;after_value:unknown}>('SELECT before_value,after_value FROM hs_audit WHERE correlation_id=$1',[op.operationId]);expect(events.rows).toEqual([{before_value:{role:null},after_value:{role:'viewer'}}]);await expect(db.query('UPDATE hs_audit SET action=$1 WHERE correlation_id=$2',['tamper',op.operationId])).rejects.toThrow('append-only');await expect(changeSharing(r,owner,f.child.id,{...op,role:'editor'})).rejects.toMatchObject({code:'operation_mismatch'});
  });
  it('rejects stale previews without overwriting a concurrent permission change',async()=>{
    const f=await fixture();await grant(f.child.id,viewer.id,'viewer');await expect(changeSharing(r,owner,f.child.id,{operationId:crypto.randomUUID(),expectedVersion:1,recipientId:viewer.id,role:'editor'})).rejects.toMatchObject({code:'sharing_conflict'});expect((await r.get(f.child.id,viewer)).role).toBe('viewer');
  });
});
