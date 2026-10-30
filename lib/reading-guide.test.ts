import {describe,expect,it} from 'vitest';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {TextSelection} from '@tiptap/pm/state';
import {readingGuidePosition} from '../components/editor/reading-guide';

function editor(content:object){return new Editor({extensions:[StarterKit],content});}

describe('temporary reading guide target',()=>{
  it('resolves only a top-level paragraph or heading at the caret',()=>{
    const value=editor({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'First'}]},{type:'heading',attrs:{level:2},content:[{type:'text',text:'Second'}]}]});
    value.view.dispatch(value.state.tr.setSelection(TextSelection.create(value.state.doc,2)));
    expect(readingGuidePosition(value)).toBe(0);
    value.view.dispatch(value.state.tr.setSelection(TextSelection.create(value.state.doc,9)));
    expect(readingGuidePosition(value)).toBe(7);
    value.destroy();
  });

  it('excludes lists, code, quotes and tables without reading the document',()=>{
    const value=editor({type:'doc',content:[{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'List'}]}]}]},{type:'codeBlock',content:[{type:'text',text:'code'}]},{type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'quote'}]}]}]});
    for(const position of [3,11,18]){value.view.dispatch(value.state.tr.setSelection(TextSelection.near(value.state.doc.resolve(position))));expect(readingGuidePosition(value)).toBeNull();}
    value.destroy();
  });
});
