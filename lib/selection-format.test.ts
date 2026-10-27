import { describe,it,expect } from 'vitest';
import { EditorState,TextSelection,NodeSelection } from '@tiptap/pm/state';
import { richSchema } from './rich-schema';
import { ensureIds } from './document';
import { mixedPaletteValue,selectionFormat } from '../components/editor/selection-format';
const schema=richSchema();
function fixture(){
 const doc=schema.nodeFromJSON(ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Bold',marks:[{type:'bold'},{type:'italic'},{type:'textStyle',attrs:{color:'#2563eb'}},{type:'highlight',attrs:{color:'#dbeafe'}}]},{type:'text',text:' plain'}]},{type:'paragraph',content:[{type:'text',text:'Other',marks:[{type:'underline'},{type:'strike'},{type:'textStyle',attrs:{color:'#dc2626'}}]}]},{type:'horizontalRule'}]}));
 return EditorState.create({doc});
}
describe('selection formatting indicators',()=>{
 it('reports all compatible styles and palettes on uniformly marked text',()=>{const state=fixture();const selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1,5)));expect(selectionFormat(selected)).toEqual({bold:true,italic:true,underline:false,strike:false,color:'#2563eb',highlight:'#dbeafe'});});
 it('reports partial marks and marked/unmarked palettes as mixed',()=>{const state=fixture(),before=state.doc.toJSON(),selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1,11)));expect(selectionFormat(selected)).toEqual({bold:'mixed',italic:'mixed',underline:false,strike:false,color:mixedPaletteValue,highlight:mixedPaletteValue});expect(state.doc.toJSON()).toEqual(before);});
 it('excludes marks on unselected adjacent text',()=>{const state=fixture(),selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,6,11)));expect(selectionFormat(selected)).toEqual({bold:false,italic:false,underline:false,strike:false,color:'',highlight:''});});
 it('handles styles across paragraphs without changing their structure',()=>{const state=fixture(),selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1,17))),result=selectionFormat(selected);expect(result.bold).toBe('mixed');expect(result.underline).toBe('mixed');expect(result.strike).toBe('mixed');expect(result.color).toBe(mixedPaletteValue);expect(selected.doc).toBe(state.doc);});
 it('uses stored typing marks and honors an explicitly cleared empty mark set',()=>{const state=fixture(),caret=state.apply(state.tr.setSelection(TextSelection.create(state.doc,3)));expect(selectionFormat(caret).bold).toBe(true);const typing=caret.apply(caret.tr.setStoredMarks([schema.marks.underline.create(),schema.marks.highlight.create({color:'#dbeafe'})]));expect(selectionFormat(typing).underline).toBe(true);expect(selectionFormat(typing).bold).toBe(false);expect(selectionFormat(typing).highlight).toBe('#dbeafe');expect(selectionFormat(caret.apply(caret.tr.setStoredMarks([])))).toEqual({bold:false,italic:false,underline:false,strike:false,color:'',highlight:''});});
 it('shows default appearance for a selected non-text atom',()=>{const state=fixture();let pos=0;state.doc.descendants((node,p)=>{if(node.type.name==='horizontalRule')pos=p;});expect(selectionFormat(state.apply(state.tr.setSelection(NodeSelection.create(state.doc,pos))))).toEqual({bold:false,italic:false,underline:false,strike:false,color:'',highlight:''});});
});
