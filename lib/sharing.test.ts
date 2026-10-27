import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createDatabase,type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { changeSharing,sharingState } from './sharing';
import { draftKey } from './drafts';
import { reserveMedia } from './media';
let db:Database,r:Repository;
const owner=localActor,editor={id:'sharing-editor'},viewer={id:'sharing-viewer'},stranger={id:'sharing-outsider'};
beforeAll(async()=>{db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();for(const a of [editor,viewer,stranger]){await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[a.id]);if(a!==stranger)await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[a.id]);}});
afterAll(async()=>{await db.close();});
async function fixture(){const root=await r.create(owner,'Private ancestor','space-product'),child=await r.create(owner,'Shared branch','space-product',root.id),grandchild=await r.create(owner,'Nested document','space-product',child.id),sibling=await r.create(owner,'Private sibling','space-product',root.id);return {root,child,grandchild,sibling};}
async function grant(id:string,recipientId:string,role:'viewer'|'commenter'|'editor'|null){const s=await sharingState(r,owner,id);return changeSharing(r,owner,id,{operationId:crypto.randomUUID(),expectedVersion:s.version,recipientId,role});}
describe('HOLY-4 inherited sharing',()=>{
  it('keeps Commenter content, uploads and draft writes read-only while inheriting the role',async()=>{const f=await fixture();await grant(f.child.id,viewer.id,'commenter');const page=await r.get(f.grandchild.id,viewer);expect(page.role).toBe('commenter');await expect(r.save(page.id,viewer,{operationId:crypto.randomUUID(),baseVersion:page.version,title:'Denied',document:page.document})).rejects.toMatchObject({code:'read_only'});await expect(draftKey(r,viewer,page.id,{id:crypto.randomUUID()})).rejects.toMatchObject({code:'read_only'});await expect(reserveMedia(r,viewer,page.id,{operationId:crypto.randomUUID(),name:'denied.txt',size:1})).rejects.toMatchObject({code:'read_only'});await expect(sharingState(r,viewer,page.id)).rejects.toMatchObject({code:'owner_required'});});
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

describe('HOLY-4 access boundaries',()=>{
  it('applies ancestor grants past100 levels and still terminates on malformed cycles',async()=>{
    const f=await fixture();await grant(f.child.id,viewer.id,'viewer');let parent=f.child.id;
    for(let i=0;i<110;i++){const id=crypto.randomUUID();await db.query("INSERT INTO hs_pages(id,workspace_id,space_id,parent_id,owner_id,title) VALUES($1,'ws-aplyd','space-product',$2,$3,'Deep page')",[id,parent,owner.id]);parent=id;}
    expect((await r.get(parent,viewer)).role).toBe('viewer');
    await db.query('UPDATE hs_pages SET parent_id=$2 WHERE id=$1',[f.root.id,parent]);
    expect((await r.get(parent,viewer)).role).toBe('viewer');
    await grant(f.child.id,viewer.id,null);await expect(r.get(parent,viewer)).rejects.toMatchObject({status:404});
  });
  it('shows the workspace-wide source and retains its effective access after a direct removal',async()=>{
    const f=await fixture();await db.query("UPDATE hs_pages SET visibility='space' WHERE id=$1",[f.child.id]);await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,'space','editor')",[f.child.id]);await grant(f.grandchild.id,viewer.id,'viewer');
    const state=await sharingState(r,owner,f.grandchild.id);expect(state.inherited).toEqual(expect.arrayContaining([expect.objectContaining({sourceId:f.child.id,recipientId:'space',recipientName:'Active workspace members',role:'editor'})]));
    expect((await grant(f.grandchild.id,viewer.id,null)).effectiveRole).toBe('editor');
    await db.query("UPDATE hs_members SET active=false WHERE user_id=$1",[viewer.id]);await expect(r.get(f.grandchild.id,viewer)).rejects.toMatchObject({status:404});
    await db.query("UPDATE hs_members SET active=true WHERE user_id=$1",[viewer.id]);
  });
});
