// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Details,DetailsSummary,DetailsContent } from '@tiptap/extension-details';
import UniqueID from '@tiptap/extension-unique-id';
import { ensureIds,idTypes } from './document';
import { FindExtension,findKey } from '../components/editor/extensions';
import { updateFindQuery } from '../components/editor/find-navigation';
import { installSectionPreferences,restoreTemporarySections,type TemporarySection } from '../components/editor/section-navigation';

for(const editable of [true,false])it(`reveals the first hidden match while query focus and content stay unchanged (editable=${editable})`,()=>{
  const documentValue=ensureIds({type:'doc',content:['Orchid','Violet'].map(text=>({type:'details',content:[{type:'detailsSummary',content:[{type:'text',text:'Section'}]},{type:'detailsContent',content:[{type:'paragraph',content:[{type:'text',text}]}]}]}))});
  const host=document.createElement('div'),input=document.createElement('input');document.body.append(host,input);
  for(const section of documentValue.content!)localStorage.setItem(`hs-collapse:qa:${section.attrs!.id}`,'closed');
  const editor=new Editor({element:host,editable,extensions:[StarterKit.configure({trailingNode:false}),Details.configure({persist:false}),DetailsSummary,DetailsContent,UniqueID.configure({types:idTypes}),FindExtension],content:documentValue});
  const stop=installSectionPreferences(editor.view.dom,'qa'),entries:TemporarySection[]=[];
  try{
    const before=editor.getJSON(),selection=editor.state.selection.toJSON();input.focus();
    const sections=Array.from(host.querySelectorAll<HTMLElement>('[data-type=details]'));
    const body=(i:number)=>sections[i].querySelector<HTMLElement>('[data-type=detailsContent]')!;
    expect(sections[0].getAttribute('data-id')).toBe(documentValue.content![0].attrs!.id);
    expect(body(0).hidden).toBe(true);expect(body(1).hidden).toBe(true);
    updateFindQuery(editor,{query:'orchid',matchCase:false},'qa',entries,true);
    expect(findKey.getState(editor.state)?.matches).toHaveLength(1);
    expect(body(0).hidden).toBe(false);expect(body(1).hidden).toBe(true);
    expect(document.activeElement).toBe(input);expect(editor.state.selection.toJSON()).toEqual(selection);
    updateFindQuery(editor,{query:'violet',matchCase:false},'qa',entries,true);
    expect(body(0).hidden).toBe(true);expect(body(1).hidden).toBe(false);
    updateFindQuery(editor,{query:'violet',matchCase:true},'qa',entries,true);
    expect(findKey.getState(editor.state)?.matches).toHaveLength(0);
    expect(body(1).hidden).toBe(true);
    updateFindQuery(editor,{query:'Orchid',matchCase:true},'qa',entries,true);
    expect(body(0).hidden).toBe(false);
    updateFindQuery(editor,{query:'Orchid',matchCase:true,wholeWords:true},'qa',entries,true);
    expect(findKey.getState(editor.state)?.wholeWords).toBe(true);
    const findState=findKey.getState(editor.state);editor.commands.setTextSelection(2);
    expect(findKey.getState(editor.state)).toBe(findState);
    restoreTemporarySections(entries);expect(body(0).hidden).toBe(true);
    expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);
    for(const section of documentValue.content!)expect(localStorage.getItem(`hs-collapse:qa:${section.attrs!.id}`)).toBe('closed');
  }finally{stop();editor.destroy();host.remove();input.remove();localStorage.clear();}
});
