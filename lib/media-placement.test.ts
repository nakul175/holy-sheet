// @vitest-environment jsdom
import { afterEach,describe,it,expect } from 'vitest';
import { Editor,Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { NodeSelection } from '@tiptap/pm/state';
import { ensureIds,idTypes } from './document';
import { applyReadyMedia,captureMediaPlacement,mediaTypeForFile } from '../components/editor/media-placement';
const editors:Editor[]=[];afterEach(()=>editors.splice(0).forEach(e=>e.destroy()));
const FileNode=Node.create({name:'file',group:'block',atom:true,addAttributes(){return {id:{default:null},attachmentId:{default:null},title:{default:''}};},parseHTML:()=>[],renderHTML:()=>['div',{'data-file':''}]});
function setup(file=false){const document=ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Existing text'}]},...(file?[{type:'file',attrs:{attachmentId:'old-object',title:'old.txt'}}]:[])]});const e=new Editor({element:window.document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),FileNode,UniqueID.configure({types:idTypes,attributeName:'id'})],content:document});editors.push(e);return e;}
const ready={id:'new-object',name:'new.txt',alt:'',caption:''};
describe('verified media placement',()=>{
 it('classifies allowed pasted/dropped filenames and rejects unsupported types',()=>{expect(mediaTypeForFile({name:'chart.PNG'})).toBe('image');expect(mediaTypeForFile({name:'notes.md'})).toBe('file');expect(mediaTypeForFile({name:'program.exe'})).toBeNull();expect(mediaTypeForFile({name:'image.svg'})).toBeNull();});
 it('adds verified media without replacing existing text and undoes in one step',()=>{const e=setup(),before=e.getJSON(),target=captureMediaPlacement(e,'file');applyReadyMedia(e,target,ready);expect(e.state.doc.child(0).textContent).toBe('Existing text');expect(e.state.doc.child(1).type.name).toBe('file');expect(e.state.doc.child(0).attrs.id).toBe(target.blockId);e.commands.undo();expect(e.getJSON()).toEqual(before);});
 it('replaces the selected media reference while preserving block identity, and Undo restores it',()=>{const e=setup(true),pos=e.state.doc.child(0).nodeSize;e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc,pos)));const before=e.getJSON(),target=captureMediaPlacement(e,'file',true);applyReadyMedia(e,target,ready);expect(e.state.doc.child(1).attrs.attachmentId).toBe('new-object');expect(e.state.doc.child(1).attrs.id).toBe(target.blockId);e.commands.undo();expect(e.getJSON()).toEqual(before);});
 it('refuses stale replacement targets without overwriting a newer reference',()=>{const e=setup(true),pos=e.state.doc.child(0).nodeSize;e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc,pos)));const target=captureMediaPlacement(e,'file',true);e.view.dispatch(e.state.tr.setNodeMarkup(pos,undefined,{...e.state.doc.child(1).attrs,attachmentId:'newer-object'}));const current=e.getJSON();expect(()=>applyReadyMedia(e,target,ready)).toThrow('destination changed');expect(e.getJSON()).toEqual(current);});
 it('refuses a removed destination and lost editing permission',()=>{const e=setup(true),pos=e.state.doc.child(0).nodeSize;e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc,pos)));const target=captureMediaPlacement(e,'file',true);e.commands.deleteSelection();expect(()=>applyReadyMedia(e,target,ready)).toThrow('removed');e.setEditable(false);expect(()=>applyReadyMedia(e,target,ready)).toThrow('no longer editable');});
});
