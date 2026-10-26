import type { Editor } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { stableStringify,type RichNode } from '../../lib/document';

/** A clean remote refresh/merge must never leave an old whole-page inverse ready to overwrite it. */
export function applyRemoteDocument(editor:Editor,document:RichNode){
  if(stableStringify(editor.getJSON())===stableStringify(document))return false;
  editor.commands.setContent(document,{emitUpdate:false});
  editor.unregisterPlugin('history');
  editor.registerPlugin(history({depth:100,newGroupDelay:750}));
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory',false));
  return true;
}
