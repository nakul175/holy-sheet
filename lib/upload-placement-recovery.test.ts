// @vitest-environment jsdom
import { describe,it,expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { ensureIds,idTypes } from './document';
import { captureMediaPlacement } from '../components/editor/media-placement';
import { compactMediaPlacement,rehydrateMediaPlacement } from './upload-placement-recovery';
describe('compact recovery placement',()=>{
 it('stores only a digest of large destination content and restores it only while unchanged',async()=>{const e=new Editor({extensions:[StarterKit.configure({trailingNode:false}),UniqueID.configure({types:idTypes})],content:ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Private destination text '.repeat(5000)}]}]})});try{const target=captureMediaPlacement(e,'file'),compact=await compactMediaPlacement(target);expect(compact.expected).toBe('');expect(compact.expectedHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(compact)).not.toContain('Private destination text');expect((await rehydrateMediaPlacement(e,compact)).expected).toBe(target.expected);e.view.dispatch(e.state.tr.insertText('Changed ',1));const before=e.getJSON();await expect(rehydrateMediaPlacement(e,compact)).rejects.toThrow('original destination changed');expect(e.getJSON()).toEqual(before);}finally{e.destroy();}});
});
