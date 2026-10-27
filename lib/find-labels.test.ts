// @vitest-environment jsdom
import { describe,it,expect } from 'vitest';
import { Editor,Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { FindExtension,findKey } from '../components/editor/extensions';
import { ensureIds,idTypes } from './document';
describe('permission-filtered find metadata',()=>{
 it('updates and removes matches without changing saved content or Undo history',()=>{const PageLink=Node.create({name:'pageLink',group:'block',atom:true,addAttributes(){return {pageId:{default:null}};},renderHTML:()=>['span',{'data-page-link':''}]});const document=ensureIds({type:'doc',content:[{type:'pageLink',attrs:{pageId:'target'}}]}),id=String(document.content![0].attrs!.id),e=new Editor({extensions:[StarterKit.configure({trailingNode:false}),PageLink,UniqueID.configure({types:idTypes}),FindExtension],content:document});try{const before=e.getJSON();e.view.dispatch(e.state.tr.setMeta(findKey,{query:'orchid',labels:{[id]:'Orchid plan'}}));expect(findKey.getState(e.state)?.matches).toHaveLength(1);e.view.dispatch(e.state.tr.setMeta(findKey,{labels:{[id]:''}}));expect(findKey.getState(e.state)?.matches).toHaveLength(0);expect(e.getJSON()).toEqual(before);expect(e.can().undo()).toBe(false);}finally{e.destroy();}});
});
