import { describe,expect,it } from 'vitest';
import { richSchema } from './rich-schema';
import { ensureIds } from './document';
import { collectMatches } from '../components/editor/extensions';
describe('page find source positions',()=>{
  it('includes only currently resolved reference/file labels and clears revoked metadata',()=>{const source=ensureIds({type:'doc',content:[{type:'pageLink',attrs:{pageId:'restricted-target'}},{type:'file',attrs:{attachmentId:crypto.randomUUID(),title:''}}]}),doc=richSchema().nodeFromJSON(source),reference=String(source.content![0].attrs!.id),file=String(source.content![1].attrs!.id);expect(collectMatches(doc,'orchid')).toHaveLength(0);expect(collectMatches(doc,'orchid',false,{[reference]:'Orchid plan',[file]:'orchid-notes.pdf'})).toHaveLength(2);expect(collectMatches(doc,'orchid',false,{[reference]:'',[file]:''})).toHaveLength(0);expect(collectMatches(doc,'restricted-target')).toHaveLength(0);});
  it('keeps source offsets after hard breaks and Unicode case folding',()=>{
    const doc=richSchema().nodeFromJSON(ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'İ 👋'},{type:'hardBreak'},{type:'text',text:'ORCHID orchid'}]}]}));
    const hits=collectMatches(doc,'orchid');expect(hits).toHaveLength(2);for(const hit of hits)expect(doc.textBetween(hit.from,hit.to).toLowerCase()).toBe('orchid');expect(collectMatches(doc,'orchid',true)).toHaveLength(1);
  });
  it('treats regex characters literally and includes protected image/file labels',()=>{
    const doc=richSchema().nodeFromJSON(ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Find [a] and [a]'}]},{type:'image',attrs:{attachmentId:crypto.randomUUID(),alt:'Orchid chart',caption:'Orchid progress'}},{type:'file',attrs:{attachmentId:crypto.randomUUID(),title:'orchid.pdf'}}]}));
    expect(collectMatches(doc,'[a]')).toHaveLength(2);const hits=collectMatches(doc,'orchid');expect(hits).toHaveLength(3);expect(hits.every(hit=>doc.nodeAt(hit.from)?.isAtom)).toBe(true);
  });
});
