import { stableStringify,type RichNode } from './document';
export function compareRevisions(before:RichNode,after:RichNode){
  const previous=before.content??[],next=after.content??[];
  const ids=new Set([...previous,...next].map(n=>String(n.attrs?.id)));
  return [...ids].flatMap(id=>{
    const a=previous.find(n=>n.attrs?.id===id),b=next.find(n=>n.attrs?.id===id);
    const oldIndex=previous.findIndex(n=>n.attrs?.id===id),newIndex=next.findIndex(n=>n.attrs?.id===id);
    if(a&&b&&stableStringify(a)===stableStringify(b)&&oldIndex===newIndex)return [];
    return [{id,before:a,after:b,label:!a?'Added':!b?'Removed':stableStringify(a)!==stableStringify(b)?'Content or formatting changed':'Moved',oldIndex,newIndex}];
  });
}
