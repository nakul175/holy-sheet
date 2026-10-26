import { describe,it,expect } from 'vitest';
import { compareRevisions } from './history-comparison';
import type { RichNode } from './document';
const block=(id:string,text:string):RichNode=>({type:'paragraph',attrs:{id},content:[{type:'text',text}]});
const doc=(...content:RichNode[]):RichNode=>({type:'doc',content});
describe('history comparison',()=>{
  it('labels additions, removals, movement and formatting changes without changing snapshots',()=>{const a=block('a','First'),b=block('b','Second'),c=block('c','Third');const before=doc(a,b,c),after=doc(b,{...a,content:[{type:'text',text:'First',marks:[{type:'bold'}]}]},block('d','New'));const original=JSON.stringify(before);const result=compareRevisions(before,after);expect(result.map(x=>[x.id,x.label])).toEqual([['a','Content or formatting changed'],['b','Moved'],['c','Removed'],['d','Added']]);expect(JSON.stringify(before)).toBe(original);});
  it('does not fabricate changes for equal rich snapshots',()=>{expect(compareRevisions(doc(block('a','Same')),doc(block('a','Same')))).toEqual([]);});
});
