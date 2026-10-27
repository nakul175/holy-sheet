import { describe,it,expect } from 'vitest';
import { transformShortcut,type TransformTarget } from '../components/editor/block-transforms';
const key=(patch:Partial<KeyboardEvent>={})=>({key:'',code:'',metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,isComposing:false,...patch});
describe('reviewed transform shortcuts',()=>{
 const targets:[Partial<KeyboardEvent>,TransformTarget][]=[
  [{code:'Digit0',altKey:true},'paragraph'],[{code:'Digit1',altKey:true},'heading-1'],[{code:'Digit2',altKey:true},'heading-2'],[{code:'Digit3',altKey:true},'heading-3'],
  [{code:'Digit7',key:'&',shiftKey:true},'number'],[{code:'Digit8',key:'*',shiftKey:true},'bullet'],[{code:'Digit9',key:'(',shiftKey:true},'checklist'],[{code:'KeyB',key:'B',shiftKey:true},'quote']
 ];
 for(const modifier of ['metaKey','ctrlKey'] as const)for(const [event,target] of targets)it(`${modifier} ${event.code} selects ${target} for the guarded path`,()=>{expect(transformShortcut(key({...event,[modifier]:true}))).toBe(target);});
 it('routes active list/checklist/quote and matching-heading toggles back through paragraph review',()=>{for(const [event,active] of [[{code:'Digit7',shiftKey:true},{number:true}],[{code:'Digit8',shiftKey:true},{bullet:true}],[{code:'Digit9',shiftKey:true},{checklist:true}],[{code:'KeyB',shiftKey:true},{quote:true}],[{code:'Digit2',altKey:true},{heading:2}]] as const)expect(transformShortcut(key({...event,metaKey:true}),active)).toBe('paragraph');});
 it('recognises shifted-symbol and legacy key-code variants without intercepting ordinary input, IME or AltGraph',()=>{expect(transformShortcut(key({key:'(',shiftKey:true,metaKey:true}),{checklist:true})).toBe('paragraph');expect(transformShortcut(key({key:'',keyCode:55,shiftKey:true,ctrlKey:true}))).toBe('number');expect(transformShortcut(key({code:'Digit1',altKey:true}))).toBeNull();expect(transformShortcut(key({code:'Digit1',altKey:true,ctrlKey:true,isComposing:true}))).toBeNull();expect(transformShortcut(key({code:'Digit1',altKey:true,ctrlKey:true,getModifierState:name=>name==='AltGraph'}))).toBeNull();expect(transformShortcut(key({key:'v',code:'KeyV',shiftKey:true,metaKey:true}))).toBeNull();});
});
