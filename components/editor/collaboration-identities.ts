import {Extension} from '@tiptap/core';
import type {Node as PMNode} from '@tiptap/pm/model';
import {Plugin,PluginKey} from '@tiptap/pm/state';
import {idTypes} from '../../lib/document';

const identifiedTypes=new Set(idTypes);
type IdentityState={known:Map<string,string>;present:Set<string>;retired:Set<string>;repairs:{pos:number;id:string}[]};
function nodes(document:PMNode){
 const found:{pos:number;id:string;type:string}[]=[];
 document.descendants((node,pos)=>{if(identifiedTypes.has(node.type.name)&&typeof node.attrs.id==='string'&&node.attrs.id)found.push({pos,id:node.attrs.id,type:node.type.name});});
 return found;
}

/** The server treats IDs as immutable typed identities, including across Undo. */
export function collaborationIdentityPlugin(canEdit:()=>boolean,generateId:()=>string=()=>crypto.randomUUID()){
 const key=new PluginKey<IdentityState>('holySheetCollaborationIdentities');
 return new Plugin<IdentityState>({
  key,
  state:{
   init:(_,state)=>{const initial=nodes(state.doc);return {known:new Map(initial.map(n=>[n.id,n.type])),present:new Set(initial.map(n=>n.id)),retired:new Set(),repairs:[]};},
   apply:(transaction,previous)=>{
    if(!transaction.docChanged)return previous;
    const current=nodes(transaction.doc),present=new Set(current.map(n=>n.id));
    const known=new Map(previous.known),retired=new Set(previous.retired);
    for(const id of previous.present)if(!present.has(id))retired.add(id);
    const repairs:{pos:number;id:string}[]=[];
    for(const node of current){
     if(retired.has(node.id)||(known.has(node.id)&&known.get(node.id)!==node.type))repairs.push({pos:node.pos,id:node.id});
     if(!known.has(node.id))known.set(node.id,node.type);
    }
    return {known,present,retired,repairs};
   },
  },
  appendTransaction:(transactions,_,state)=>{
   if(!canEdit()||!transactions.some(transaction=>transaction.docChanged))return;
   const identities=key.getState(state);if(!identities?.repairs.length)return;
   const transaction=state.tr,generated=new Set<string>();
   for(const repair of identities.repairs){
    const node=transaction.doc.nodeAt(repair.pos);if(!node||node.attrs.id!==repair.id)continue;
    let id='';for(let attempt=0;attempt<16;attempt++){const candidate=generateId();if(candidate&&!identities.known.has(candidate)&&!generated.has(candidate)){id=candidate;break;}}
    if(!id)throw Error('A fresh collaboration block identity could not be allocated.');
    generated.add(id);transaction.setNodeMarkup(repair.pos,undefined,{...node.attrs,id});
   }
   if(!transaction.docChanged)return;
   transaction.setStoredMarks(state.storedMarks);
   // Match UniqueID's metadata and avoid adding an extra user Undo entry.
   return transaction.setMeta('__uniqueIDTransaction',true).setMeta('addToHistory',false);
  },
 });
}

/** UniqueID (priority 10000) first supplies and deduplicates IDs. */
export const CollaborationIdentities=Extension.create({
 name:'holySheetCollaborationIdentities',priority:9999,
 addProseMirrorPlugins(){return [collaborationIdentityPlugin(()=>this.editor.isEditable)];},
});
