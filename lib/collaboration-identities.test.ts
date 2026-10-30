import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {EditorState,TextSelection} from '@tiptap/pm/state';
import {history,undo,redo} from '@tiptap/pm/history';
import {collab,receiveTransaction,sendableSteps} from 'prosemirror-collab';
import {Step} from '@tiptap/pm/transform';
import {collaborationIdentityPlugin} from '../components/editor/collaboration-identities';
import {richSchema} from './rich-schema';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner} from './auth';
import {beginCollaboration,pullCollaboration,submitCollaboration} from './collaboration';

const schema=richSchema();
const paragraph=(id='original',text='Keep these words')=>schema.nodes.paragraph.create({id},schema.text(text));
const makeState=(canEdit=()=>true)=>EditorState.create({schema,doc:schema.nodes.doc.create(null,[paragraph()]),plugins:[history(),collaborationIdentityPlugin(canEdit)]});
describe('collaborative immutable typed block identities',()=>{
 it('gives a type conversion a fresh identity, preserving content, marks and selection',()=>{
  let state=makeState();const marked=state.tr.addMark(1,5,schema.marks.bold.create());state=state.apply(marked.setSelection(TextSelection.create(marked.doc,2,6)));
  const content=state.doc.firstChild!.content.toJSON();
  const result=state.applyTransaction(state.tr.setNodeMarkup(0,schema.nodes.heading,{id:'original',level:2}));
  expect(result.state.doc.firstChild?.type.name).toBe('heading');expect(result.state.doc.firstChild?.attrs.id).not.toBe('original');
  expect(result.state.doc.textContent).toBe('Keep these words');expect(result.state.selection.toJSON()).toEqual(state.selection.toJSON());
  expect(result.state.doc.firstChild!.content.toJSON()).toEqual(content);
  expect(result.transactions).toHaveLength(2);expect(result.transactions[1].getMeta('addToHistory')).toBe(false);
 });
 it('does not rewrite stable identities for typing, heading-level changes or block moves',()=>{
  let state=makeState();state=state.applyTransaction(state.tr.insertText('More ',1)).state;expect(state.doc.firstChild?.attrs.id).toBe('original');
  state=state.applyTransaction(state.tr.setNodeMarkup(0,schema.nodes.heading,{id:'original',level:1})).state;const id=state.doc.firstChild!.attrs.id;
  state=state.applyTransaction(state.tr.setNodeMarkup(0,undefined,{id,level:3})).state;expect(state.doc.firstChild?.attrs.id).toBe(id);
  state=state.applyTransaction(state.tr.insert(state.doc.content.size,paragraph('second','Second'))).state;
  const first=state.doc.firstChild!;state=state.applyTransaction(state.tr.delete(0,first.nodeSize).insert(state.doc.content.size-first.nodeSize,first)).state;
  expect(state.doc.lastChild?.attrs.id).toBe(id);expect(state.doc.firstChild?.attrs.id).toBe('second');
 });
 it('allocates fresh identities on Undo and Redo instead of reviving retired IDs',()=>{
  let state=makeState();state=state.applyTransaction(state.tr.setNodeMarkup(0,schema.nodes.heading,{id:'original',level:2})).state;
  const headingId=state.doc.firstChild!.attrs.id;
  expect(undo(state,tr=>{state=state.applyTransaction(tr).state;})).toBe(true);const undoId=state.doc.firstChild!.attrs.id;
  expect(state.doc.firstChild?.type.name).toBe('paragraph');expect(undoId).not.toBe('original');expect(undoId).not.toBe(headingId);
  expect(redo(state,tr=>{state=state.applyTransaction(tr).state;})).toBe(true);
  expect(state.doc.firstChild?.type.name).toBe('heading');expect([headingId,undoId,'original']).not.toContain(state.doc.firstChild!.attrs.id);
  expect(state.doc.textContent).toBe('Keep these words');
 });
 it('gives an undone deletion a new identity while preserving the restored content',()=>{
  let state=makeState();state=state.applyTransaction(state.tr.insert(state.doc.content.size,paragraph('survivor','Survives'))).state;
  // Keep the setup insertion outside the deletion's Undo group.
  state=EditorState.create({schema,doc:state.doc,plugins:[history(),collaborationIdentityPlugin(()=>true)]});
  state=state.applyTransaction(state.tr.delete(0,state.doc.firstChild!.nodeSize)).state;
  expect(undo(state,tr=>{state=state.applyTransaction(tr).state;})).toBe(true);
  expect(state.doc.firstChild?.textContent).toBe('Keep these words');expect(state.doc.firstChild?.attrs.id).not.toBe('original');
  expect(state.doc.lastChild?.attrs.id).toBe('survivor');
 });
 it('does no automatic document repair in a read-only editor or on selection-only activity',()=>{
  const state=makeState(()=>false),converted=state.applyTransaction(state.tr.setNodeMarkup(0,schema.nodes.heading,{id:'original',level:1}));
  expect(converted.transactions).toHaveLength(1);expect(converted.state.doc.firstChild?.attrs.id).toBe('original');
  const selected=state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc,2)));expect(selected.transactions).toHaveLength(1);expect(selected.state.doc.eq(state.doc)).toBe(true);
 });
 it('does not reuse an existing generated identity',()=>{
  let calls=0;const state=EditorState.create({schema,doc:schema.nodes.doc.create(null,[paragraph()]),plugins:[collaborationIdentityPlugin(()=>true,()=>++calls===1?'original':'new-id')]});
  const next=state.applyTransaction(state.tr.setNodeMarkup(0,schema.nodes.heading,{id:'original',level:1}));expect(next.state.doc.firstChild?.attrs.id).toBe('new-id');expect(calls).toBe(2);
 });
});

describe('actual server acceptance and peer convergence',()=>{
 let db:Database,repository:Repository;
 beforeAll(async()=>{db=await createDatabase(':memory:');repository=new Repository(db);await repository.seedLocal();});afterAll(async()=>{await db?.close();});
 it('persists paragraph to heading, Undo and Redo through unchanged identity guards and rebases a second client',async()=>{
  const page=await repository.create(owner,'Synthetic typed collaboration identities','space-product'),clientA=crypto.randomUUID(),clientB=crypto.randomUUID();
  const a=await beginCollaboration(repository,owner,page.id,clientA),b=await beginCollaboration(repository,owner,page.id,clientB);
  const original=a.document.content![0].attrs!.id;
  const unsafe=EditorState.create({schema,doc:schema.nodeFromJSON(a.document)});
  await expect(submitCollaboration(repository,owner,page.id,{sessionId:a.sessionId,epoch:a.epoch,clientId:clientA,operationId:crypto.randomUUID(),baseStepVersion:0,steps:unsafe.tr.setNodeMarkup(0,schema.nodes.heading,{...unsafe.doc.firstChild!.attrs,level:2}).steps.map(step=>step.toJSON())})).rejects.toMatchObject({code:'collaboration_identity_invalid'});
  expect((await repository.get(page.id,owner)).version).toBe(page.version);
  let first=EditorState.create({schema,doc:schema.nodeFromJSON(a.document),plugins:[history(),collab({version:a.stepVersion,clientID:clientA}),collaborationIdentityPlugin(()=>true)]});
  let second=EditorState.create({schema,doc:schema.nodeFromJSON(b.document),plugins:[collab({version:b.stepVersion,clientID:clientB}),collaborationIdentityPlugin(()=>true)]});
  let stepVersion=0,lastPageVersion=page.version;const ids=new Set([original]);
  async function send(){
   const pending=sendableSteps(first)!;expect(pending).not.toBeNull();
   const result=await submitCollaboration(repository,owner,page.id,{sessionId:a.sessionId,epoch:a.epoch,clientId:clientA,operationId:crypto.randomUUID(),baseStepVersion:pending.version,steps:pending.steps.map(step=>step.toJSON())});
   const pulled=await pullCollaboration(repository,owner,page.id,{sessionId:b.sessionId,epoch:b.epoch,clientId:clientB,afterVersion:stepVersion});
   const records=pulled.steps,steps=records.map(record=>Step.fromJSON(schema,record.step)),clients=records.map(record=>record.clientId);
   first=first.applyTransaction(receiveTransaction(first,steps,clients)).state;second=second.applyTransaction(receiveTransaction(second,steps,clients)).state;
   stepVersion=result.stepVersion;expect(result.pageVersion).toBeGreaterThan(lastPageVersion);lastPageVersion=result.pageVersion;
   const stored=await repository.get(page.id,owner);expect(stored.document).toEqual(first.doc.toJSON());expect(second.doc.eq(first.doc)).toBe(true);expect(sendableSteps(second)).toBeNull();
   const id=stored.document.content![0].attrs!.id;expect(ids.has(id)).toBe(false);ids.add(id);return stored;
  }
  first=first.applyTransaction(first.tr.setNodeMarkup(0,schema.nodes.heading,{...first.doc.firstChild!.attrs,level:2})).state;
  expect((await send()).document.content![0].type).toBe('heading');
  expect(undo(first,tr=>{first=first.applyTransaction(tr).state;})).toBe(true);expect((await send()).document.content![0].type).toBe('paragraph');
  expect(redo(first,tr=>{first=first.applyTransaction(tr).state;})).toBe(true);expect((await send()).document.content![0].type).toBe('heading');
  expect((await db.query('SELECT block_id FROM hs_collaboration_tombstones WHERE page_id=$1',[page.id])).rows.map(row=>row.block_id)).toContain(original);
 });
});
