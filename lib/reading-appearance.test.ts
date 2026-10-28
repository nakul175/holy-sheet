import {expect,it,vi} from 'vitest';
import {defaultReadingAppearance,readingAppearanceKey,decodeReadingAppearance,validReadingAppearance,readReadingAppearance,writeReadingAppearance,resetReadingAppearance,type ReadingStorage} from './reading-appearance';
const choices={textSize:'extra-large',lineSpacing:'relaxed',pageWidth:'wide'} as const;
function memory(){const entries=new Map<string,string>(),storage:ReadingStorage={getItem:vi.fn(key=>entries.get(key)??null),setItem:vi.fn((key,value)=>{entries.set(key,value);}),removeItem:vi.fn(key=>{entries.delete(key);})};return {entries,storage};}
it('accepts only the exact versioned predefined choices and rejects unknown or oversized records',()=>{
 expect(decodeReadingAppearance(JSON.stringify({version:1,...choices}))).toEqual(choices);
 for(const value of [null,'', '{', 'x'.repeat(513),JSON.stringify({version:2,...choices}),JSON.stringify({version:1,...choices,document:'PRIVATE'}),JSON.stringify({version:1,...choices,textSize:'40px;position:fixed'}),JSON.stringify({version:1,...choices,pageWidth:900}),JSON.stringify([choices]),JSON.stringify({version:1,textSize:'default',lineSpacing:'default',extra:'wide'})])expect(decodeReadingAppearance(value)).toBeNull();
 expect(validReadingAppearance({...choices,extra:true})).toBe(false);expect(validReadingAppearance(Object.assign(Object.create(choices),{a:1,b:2,c:3}))).toBe(false);
});
it('isolates actor keys, writes only four allowlisted fields and resets only the current actor',()=>{
 const {entries,storage}=memory();expect(writeReadingAppearance('actor:A',choices,()=>storage)).toBe(true);const key=readingAppearanceKey('actor:A')!;expect(key).not.toBe(readingAppearanceKey('actor%3AA'));expect(Object.keys(JSON.parse(entries.get(key)!))).toEqual(['version','textSize','lineSpacing','pageWidth']);
 expect(readReadingAppearance('actor:B',()=>storage).values).toEqual(defaultReadingAppearance);expect(readReadingAppearance('actor:A',()=>storage).values).toEqual(choices);
 entries.set(readingAppearanceKey('actor:B')!,'keep');expect(resetReadingAppearance('actor:A',()=>storage)).toBe(true);expect(entries.has(key)).toBe(false);expect(entries.get(readingAppearanceKey('actor:B')!)).toBe('keep');
});
it('never touches storage for unresolved or malformed actors',()=>{const factory=vi.fn(()=>memory().storage);for(const actor of ['', ' actor','actor\n', 'a'.repeat(201),'\ud800']){expect(readingAppearanceKey(actor)).toBeNull();expect(readReadingAppearance(actor,factory).values).toEqual(defaultReadingAppearance);expect(writeReadingAppearance(actor,choices,factory)).toBe(false);expect(resetReadingAppearance(actor,factory)).toBe(false);}expect(factory).not.toHaveBeenCalled();});
it('falls back safely for corrupted data and unavailable getters, reads, writes or resets',()=>{
 const {storage,entries}=memory();entries.set(readingAppearanceKey('actor')!,'{"version":99}');expect(readReadingAppearance('actor',()=>storage)).toEqual({values:defaultReadingAppearance,persistent:true,invalid:true});
 const blocked=()=>{throw new Error('Storage denied');};expect(readReadingAppearance('actor',blocked)).toEqual({values:defaultReadingAppearance,persistent:false,invalid:false});expect(writeReadingAppearance('actor',choices,blocked)).toBe(false);expect(resetReadingAppearance('actor',blocked)).toBe(false);
 storage.getItem=()=>{throw new Error('Denied');};storage.setItem=()=>{throw new Error('Quota');};storage.removeItem=()=>{throw new Error('Denied');};expect(readReadingAppearance('actor',()=>storage).persistent).toBe(false);expect(writeReadingAppearance('actor',choices,()=>storage)).toBe(false);expect(resetReadingAppearance('actor',()=>storage)).toBe(false);
});
