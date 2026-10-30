// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdirSync,writeFileSync } from 'node:fs';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { AllSelection,NodeSelection,TextSelection } from '@tiptap/pm/state';
import { CODE_POSITION_MAX_UNITS,createCodePositionReader,codePositionAnnouncement,codePositionText,createCodePositionIndex } from '../components/editor/code-position';

const codePosition=createCodePositionReader();

const editors:Editor[]=[];
afterEach(()=>{editors.splice(0).forEach(e=>e.destroy());vi.restoreAllMocks();});
function fixture(text='A👩‍💻e\u0301\tZ\r\n\r\nEnd\n',editable=true){
  const e=new Editor({element:document.createElement('div'),editable,extensions:[StarterKit.configure({trailingNode:false})],content:{type:'doc',content:[{type:'codeBlock',content:text?[{type:'text',text}]:[]},{type:'paragraph',content:[{type:'text',text:'Outside'}]},{type:'codeBlock',content:[{type:'text',text:'Other'}]}]}});editors.push(e);return e;
}
function select(e:Editor,from:number,to=from){e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc,from,to)));}

describe('pure logical code positions',()=>{
  it('counts graphemes, tabs, CRLF, empty and final lines without source normalization',()=>{
    const source='A👩‍💻e\u0301\tZ\r\n\r\nEnd\n',index=createCodePositionIndex(source);
    expect(index.lines).toBe(4);
    for(const [offset,character] of [[0,1],[1,2],[6,3],[8,4],[9,5],[10,6],[11,6]])expect(index.pointAt(offset)).toEqual({line:1,character,lineLength:5});
    expect(index.pointAt(12)).toEqual({line:2,character:1,lineLength:0});
    expect(index.pointAt(13)).toEqual({line:2,character:1,lineLength:0});
    expect(index.pointAt(14)).toEqual({line:3,character:1,lineLength:3});
    expect(index.pointAt(17)).toEqual({line:3,character:4,lineLength:3});
    expect(index.pointAt(18)).toEqual({line:4,character:1,lineLength:0});
  });
  it('clamps every interior UTF-16 offset of an emoji/combining grapheme to its preceding boundary',()=>{
    const index=createCodePositionIndex('A👩‍💻e\u0301');
    for(const offset of [2,3,4,5])expect(index.pointAt(offset)).toMatchObject({character:2,lineLength:3});
    expect(index.pointAt(7)).toMatchObject({character:3,lineLength:3});
    expect(index.pointAt(8)).toMatchObject({character:4,lineLength:3});
  });
  it.each(['🇮🇳','👍🏽','क्ष','\uD800'])('does not count code units as characters for %s',text=>{
    const index=createCodePositionIndex(text);expect(index.pointAt(0)).toEqual({line:1,character:1,lineLength:1});expect(index.pointAt(text.length)).toEqual({line:1,character:2,lineLength:1});
  });
  it('keeps a lone CR literal and handles LF and empty code',()=>{
    expect(createCodePositionIndex('x\ry').pointAt(3)).toEqual({line:1,character:4,lineLength:3});
    expect(createCodePositionIndex('\n').pointAt(1)).toEqual({line:2,character:1,lineLength:0});
    expect(createCodePositionIndex('').pointAt(0)).toEqual({line:1,character:1,lineLength:0});
  });
  it.each([-1,99,NaN,Infinity,.5])('rejects invalid offset %s instead of inventing a position',offset=>expect(createCodePositionIndex('abc').pointAt(offset)).toBeNull());
  it('bounds optional inspection without inventing truncated counts',()=>{
    expect(createCodePositionIndex('x'.repeat(CODE_POSITION_MAX_UNITS+1)).pointAt(0)).toBeNull();
    const e=fixture('x'.repeat(CODE_POSITION_MAX_UNITS+1));select(e,1);expect(codePosition(e.state)).toBeNull();expect(e.state.doc.firstChild!.textContent).toHaveLength(CODE_POSITION_MAX_UNITS+1);
  });
  it('caches a large Unicode line for repeated indexed position queries',()=>{
    const source='👩‍💻'.repeat(20_000)+'\n'+'x'.repeat(100_000),began=performance.now(),index=createCodePositionIndex(source);expect(index.pointAt(100_000)).toEqual({line:1,character:20_001,lineLength:20_000});const cold=performance.now()-began,warmStart=performance.now();
    for(let i=0;i<10_000;i++)expect(index.pointAt((i*5)%100_000)?.character).toBe(i+1);
    const warm=performance.now()-warmStart,metrics={codeUnits:source.length,coldMilliseconds:cold,cachedQueries:10000,warmMilliseconds:warm};mkdirSync('artifacts/holy140',{recursive:true});writeFileSync('artifacts/holy140/unicode-index-performance.json',JSON.stringify(metrics,null,2));expect(cold).toBeLessThan(2000);expect(warm).toBeLessThan(2000);
  });
});

describe('read-only editor inspection',()=>{
  it('reports exact caret and reversed same-block range without document, selection or Undo writes',()=>{
    const e=fixture(),before=e.getJSON();select(e,2,9);const selection=e.state.selection.toJSON(),transactions=vi.fn();e.on('transaction',transactions);
    expect(codePosition(e.state)).toMatchObject({lines:4,range:true,from:{line:1,character:2,lineLength:5},to:{line:1,character:4,lineLength:5}});
    expect(e.state.selection.toJSON()).toEqual(selection);expect(e.getJSON()).toEqual(before);expect(e.can().undo()).toBe(false);expect(transactions).not.toHaveBeenCalled();
    select(e,9,2);const reversed=e.state.selection.toJSON();expect(codePosition(e.state)?.from.character).toBe(2);expect(codePosition(e.state)?.to.character).toBe(4);expect(e.state.selection.toJSON()).toEqual(reversed);
  });
  it('rejects mixed, cross-block, node and all-document selections',()=>{
    const e=fixture('abc'),paragraphStart=e.state.doc.firstChild!.nodeSize+1;
    select(e,2,paragraphStart+2);expect(codePosition(e.state)).toBeNull();
    const secondCode=e.state.doc.child(0).nodeSize+e.state.doc.child(1).nodeSize+1;select(e,2,secondCode+2);expect(codePosition(e.state)).toBeNull();
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc,0)));expect(codePosition(e.state)).toBeNull();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));expect(codePosition(e.state)).toBeNull();
    select(e,paragraphStart);expect(codePosition(e.state)).toBeNull();
  });
  it('uses the immutable selected-block cache for repeated caret/meta movement and refreshes after a real edit',()=>{
    const e=fixture('😀'.repeat(100)+'\nlast'),first=e.state.doc.firstChild!;select(e,1);const read=vi.spyOn(first,'textContent','get');
    expect(codePosition(e.state)?.from.lineLength).toBe(100);
    for(let i=0;i<20;i++){select(e,i*2+1);codePosition(e.state);e.view.dispatch(e.state.tr.setMeta('unrelated',i));codePosition(e.state);}
    expect(read).toHaveBeenCalledTimes(1);
    e.commands.insertContent('x');expect(codePosition(e.state)?.from.lineLength).toBe(101);expect(e.can().undo()).toBe(true);e.commands.undo();expect(codePosition(e.state)?.from.lineLength).toBe(100);
  });
  it('works for existing read-only state and never changes its rights',()=>{
    const e=fixture('read\nonly',false);select(e,8);const before=e.getJSON();expect(codePosition(e.state)).toMatchObject({from:{line:2,character:3,lineLength:4}});expect(e.isEditable).toBe(false);expect(e.getJSON()).toEqual(before);expect(e.can().undo()).toBe(false);
  });
  it('does not retain a departed block or share a cache between actor/editor readers',()=>{
    const e=fixture('😀'.repeat(10)),node=e.state.doc.firstChild!,read=vi.spyOn(node,'textContent','get'),first=createCodePositionReader(),other=createCodePositionReader();select(e,1);first(e.state);first(e.state);expect(read).toHaveBeenCalledTimes(1);other(e.state);expect(read).toHaveBeenCalledTimes(2);
    select(e,node.nodeSize+1);expect(first(e.state)).toBeNull();select(e,1);first(e.state);expect(read).toHaveBeenCalledTimes(3);
  });
  it('labels end-of-line accurately and omits per-character changes from announcements',()=>{
    const e=fixture('abc\nlast');select(e,1);const initial=codePosition(e.state)!;select(e,4);const end=codePosition(e.state)!;
    expect(codePositionText(end)).toBe('Code: line 1 of 2, character position 4 (end of line). 3 characters in line.');
    expect(codePositionAnnouncement(initial)).toEqual(codePositionAnnouncement(end));select(e,5);expect(codePositionAnnouncement(codePosition(e.state)).key).not.toBe(codePositionAnnouncement(end).key);
    expect(codePositionText(null)).toBe('');
  });
});
