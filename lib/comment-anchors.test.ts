import { describe,expect,it } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { ensureIds,type RichNode } from './document';
import { createAnchors,mapAnchors,mapAnchorsThroughSteps } from './comment-anchors';
import { richSchema } from './rich-schema';
const document=(text:string):RichNode=>ensureIds({type:'doc',content:[{type:'paragraph',attrs:{id:'stable'},content:[{type:'text',text}]}]});
describe('conservative discussion anchors',()=>{
  it('preserves a moved block and maps insertion/removal before the passage',()=>{const before=document('Hello orchid'),anchors=createAnchors(before,[{blockId:'stable',start:6,end:12}]);expect(mapAnchors(anchors,before,document('New Hello orchid'))[0]).toMatchObject({start:10,end:16,status:'attached'});expect(mapAnchors(anchors,before,document('orchid'))[0]).toMatchObject({start:0,end:6,status:'attached'});const moved=document('Hello orchid');moved.content!.unshift(...ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'New block'}]}]}).content!);expect(mapAnchors(anchors,before,moved)).toEqual(anchors);});
  it('does not silently reattach a deleted or changed passage to unrelated matching text',()=>{const before=document('Hello orchid'),anchors=createAnchors(before,[{blockId:'stable',start:6,end:12}]);const changed=mapAnchors(anchors,before,document('Hello flower'));expect(changed[0]).toMatchObject({quote:'orchid',status:'detached'});expect(mapAnchors(changed,document('Hello flower'),document('Hello orchid'))[0].status).toBe('detached');expect(mapAnchors(anchors,before,{type:'doc',content:[{type:'paragraph',attrs:{id:'other'},content:[{type:'text',text:'orchid'}]}]})[0]).toMatchObject({quote:'orchid',status:'detached'});});
  it('validates source ranges and uses the current server passage as the quote',()=>{expect(()=>createAnchors(document('Text'),[{blockId:'stable',start:0,end:999}])).toThrow('changed');expect(createAnchors(document('Text'),[{blockId:'stable',start:0,end:4}])[0].quote).toBe('Text');});
});

describe('collaboration step anchor mapping',()=>{
  const text='aaa XXX bbb',start=4,end=7;
  function editor(value:RichNode=document(text)){return EditorState.create({schema:richSchema(),doc:richSchema().nodeFromJSON(value)});}
  it('keeps the quote attached for every insertion outside the range',()=>{
    const before=document(text),anchors=createAnchors(before,[{blockId:'stable',start,end}]),base=editor(before);
    for(let pos=1;pos<=text.length+1;pos++){
      const local=pos-1;
      if(local>start&&local<end)continue;
      const mapped=mapAnchorsThroughSteps(anchors,before,base.tr.insertText('Q',pos).steps);
      expect(mapped,`insert at ${pos}`).not.toBeNull();
      expect(mapped![0].status).toBe('attached');
      expect(mapped![0].quote).toBe('XXX');
      const after=base.apply(base.tr.insertText('Q',pos)).doc;
      let slice='';
      after.descendants(node=>{if(node.isTextblock&&node.attrs.id==='stable')slice=node.textBetween(mapped![0].start,mapped![0].end,'','\n');});
      expect(slice).toBe('XXX');
    }
  });
  it('remaps edits on both sides that a single prefix/suffix diff cannot place',()=>{
    const before=document(text),anchors=createAnchors(before,[{blockId:'stable',start,end}]),base=editor(before);
    const steps=base.tr.delete(1,2).insertText('Z',base.tr.delete(1,2).doc.content.size-1).steps;
    const mapped=mapAnchorsThroughSteps(anchors,before,steps);
    expect(mapped![0]).toMatchObject({quote:'XXX',status:'attached'});
    expect(mapAnchors(anchors,before,document('aa XXX bbbZ'))[0].status).not.toBe('attached');
  });
  it('detaches a deleted passage and keeps the original quote',()=>{
    const before=document(text),anchors=createAnchors(before,[{blockId:'stable',start,end}]),base=editor(before);
    const removed=mapAnchorsThroughSteps(anchors,before,base.tr.delete(5,8).steps);
    expect(removed![0]).toMatchObject({quote:'XXX',status:'detached',start,end});
    const partial=mapAnchorsThroughSteps(anchors,before,base.tr.delete(5,6).steps);
    expect(partial![0]).toMatchObject({quote:'XXX',status:'detached'});
  });
});
