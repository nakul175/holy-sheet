import { describe,it,expect,vi } from 'vitest';
import { normalizeRichDocument } from './editor-document';
import { validateDocument } from './document';
describe('canonical editor documents',()=>{
 it('removes library-only null defaults while retaining decimal lists and safe links',()=>{const canonical=normalizeRichDocument({type:'doc',content:[{type:'orderedList',attrs:{start:3,type:null},content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'Kept link',marks:[{type:'link',attrs:{href:'https://example.com',target:'_blank',rel:'noopener noreferrer',class:null,title:null}}]}]}]}]}]});expect(()=>validateDocument(canonical)).not.toThrow();expect(canonical.content![0].attrs!.start).toBe(3);expect(canonical.content![0].attrs).not.toHaveProperty('type');const link=canonical.content![0].content![0].content![0].content![0].marks![0];expect(link.attrs).not.toHaveProperty('title');expect(link.attrs!.href).toBe('https://example.com');});
 it('does not silently accept unsupported non-default ordered-list styles',()=>{const canonical=normalizeRichDocument({type:'doc',content:[{type:'orderedList',attrs:{type:'a'},content:[{type:'listItem',content:[{type:'paragraph'}]}]}]});expect(()=>validateDocument(canonical)).toThrow('Unsupported attributes');});
 it('validates Unicode documents without a Node Buffer global',()=>{vi.stubGlobal('Buffer',undefined);try{expect(()=>validateDocument(normalizeRichDocument({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'हिन्दी 📝 é'}]}]}))).not.toThrow();}finally{vi.unstubAllGlobals();}});
});
