// @vitest-environment jsdom
import { describe,it,expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import UniqueID from '@tiptap/extension-unique-id';
import { templateStarters } from './template-starters';
import { prepareTemplateDocument } from './template-document';
import { stableStringify,idTypes } from './document';
describe('starter editor initialization',()=>{
 it('does not change the meeting-note structure on editor mount',async()=>{const source=templateStarters[0].document,editor=new Editor({extensions:[StarterKit,TaskList,TaskItem.configure({nested:true}),UniqueID.configure({types:idTypes,attributeName:'id'})],content:source});try{await new Promise(resolve=>setTimeout(resolve,30));expect(stableStringify(editor.getJSON())).toBe(stableStringify(source));}finally{editor.destroy();}});
 it('prepares deterministic defaults and trailing paragraph before publication',()=>{const source=templateStarters[0].document;expect(prepareTemplateDocument(source)).toEqual(source);expect(source.content!.at(-1)?.type).toBe('paragraph');});
});
