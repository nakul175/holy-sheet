import {it,expect} from 'vitest';
import {holy2Pages,holy2Queries,fixtureAllowed,holy2Seed} from '../scripts/holy2-fixtures';
it('generates a deterministic isolated 10k/2k plan with twenty blocks, ten spaces and depth-ten chains',()=>{
 let w1=0,w2=0,restricted=0,bytes=0;const spaces=new Set<string>(),lastById=new Map<string,number>(),maxDepth={value:0};
 for(const p of holy2Pages()){
  expect(p.blocks).toHaveLength(20);const depth=p.parentPageId?(lastById.get(p.parentPageId)??-100)+1:0;lastById.set(p.id,depth);maxDepth.value=Math.max(depth,maxDepth.value);expect(depth).toBeLessThanOrEqual(10);
  if(p.workspaceId.endsWith('w1')){w1++;spaces.add(p.spaceId);bytes+=p.blocks.reduce((n,b)=>n+Buffer.byteLength(b.text),0);const index=Number(p.id.slice(-5));if(!Array.from({length:5},(_,r)=>fixtureAllowed(index,r)).every(Boolean))restricted++;}else w2++;
 }
 expect([w1,w2,restricted,spaces.size,maxDepth.value]).toEqual([10000,2000,2000,10,10]);expect(bytes/w1).toBe(8200);
 const mix=holy2Queries();expect(new Set(mix.map(x=>x.reader)).size).toBe(5);for(const kind of new Set(mix.map(x=>x.kind)))expect(mix.filter(x=>x.kind===kind)).toHaveLength(20);expect(mix.every(x=>x.workspaceId===holy2Seed+'-w1')).toBe(true);
});
