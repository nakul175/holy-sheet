// @vitest-environment jsdom
import { describe,it,expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Details,DetailsSummary,DetailsContent } from '@tiptap/extension-details';
import UniqueID from '@tiptap/extension-unique-id';
import { ensureIds,idTypes } from './document';
import { FindExtension,findKey } from '../components/editor/extensions';
import { installSectionPreferences,openSectionsForNavigation,restoreTemporarySections,type TemporarySection } from '../components/editor/section-navigation';

describe('section view state with the actual editor schema',()=>{
 it('keeps hidden content searchable without changing document JSON or Undo',async()=>{
  const source=ensureIds({type:'doc',content:[{type:'details',content:[{type:'detailsSummary',content:[{type:'text',text:'Section'}]},{type:'detailsContent',content:[{type:'paragraph',content:[{type:'text',text:'Orchid remains searchable'}]}]}]}]});
  const key=`hs-collapse:viewer:${source.content![0].attrs!.id}`;localStorage.setItem(key,'closed');
  const element=document.createElement('div');document.body.append(element);
  const editor=new Editor({element,editable:false,extensions:[StarterKit.configure({trailingNode:false}),Details.configure({persist:false}),DetailsSummary,DetailsContent,UniqueID.configure({types:idTypes}),FindExtension],content:source});
  const stop=installSectionPreferences(editor.view.dom,'viewer');
  try{
   const before=editor.getJSON(),section=editor.view.dom.querySelector<HTMLElement>('[data-type=details]')!,content=section.querySelector<HTMLElement>('[data-type=detailsContent]')!;
   expect(content.hidden).toBe(true);editor.view.dispatch(editor.state.tr.setMeta(findKey,{query:'orchid'}));
   expect(findKey.getState(editor.state)?.matches).toHaveLength(1);
   const entries:TemporarySection[]=[];openSectionsForNavigation(content.querySelector('p'),'viewer',entries);expect(content.hidden).toBe(false);
   restoreTemporarySections(entries);expect(content.hidden).toBe(true);expect(section.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
   expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);expect(localStorage.getItem(key)).toBe('closed');
  }finally{stop();editor.destroy();element.remove();localStorage.removeItem(key);}
 });
 it('initializes newly inserted sections as expanded without adding a second undo step',async()=>{
  const element=document.createElement('div');document.body.append(element);
  const editor=new Editor({element,extensions:[StarterKit.configure({trailingNode:false}),Details.configure({persist:false}),DetailsSummary,DetailsContent,UniqueID.configure({types:idTypes})],content:ensureIds({type:'doc',content:[{type:'paragraph'}]})});
  const stop=installSectionPreferences(editor.view.dom,'editor');
  try{
   const before=editor.getJSON();editor.commands.insertContent(ensureIds({type:'doc',content:[{type:'details',content:[{type:'detailsSummary',content:[{type:'text',text:'New section'}]},{type:'detailsContent',content:[{type:'paragraph'}]}]}]}).content!);
   await Promise.resolve();const section=editor.view.dom.querySelector<HTMLElement>('[data-type=details]')!;
   expect(section.classList.contains('is-open')).toBe(true);expect(section.querySelector<HTMLElement>('[data-type=detailsContent]')!.hidden).toBe(false);
   editor.commands.undo();expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);
  }finally{stop();editor.destroy();element.remove();}
 });
});
