import { ensureIds,highlights,languages,palette,safeUrl,stableStringify,type RichNode } from "./document";
export function semanticRichDocument(document:RichNode):RichNode {
  function walk(value:unknown,key=""):unknown {
    if(Array.isArray(value)){
      const items=value.map(item=>walk(item));
      return key==="marks"?items.sort((a,b)=>stableStringify(a).localeCompare(stableStringify(b))):items;
    }
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).flatMap(([name,item])=>{
      if(item===null||(name==="content"&&Array.isArray(item)&&item.length===0))return [];
      if(name==="syncVersion"||name==="syncState"||name==="syncLocked"||name==="syncUndo")return [];
      return [[name,walk(item,name)]];
    }));
    return value;
  }
  return walk(document) as RichNode;
}
export function rgbToHex(value:string){const m=/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);return m?'#'+m.slice(1).map(v=>Number(v).toString(16).padStart(2,'0')).join(''):value.toLowerCase();}
export function normalizeRichDocument(document:RichNode):RichNode {
  function walk(n:RichNode):RichNode {
    const attrs={...n.attrs};
    // Alignment is not part of the HS table schema; Tiptap supplies it as a nullable default.
    if(["tableCell","tableHeader"].includes(n.type))delete attrs.align;
    if(n.type==="codeBlock")attrs.language=languages.includes(String(attrs.language))?attrs.language:"plaintext";
    if(n.type==="image"){delete attrs.height;attrs.src=`/api/media/${attrs.attachmentId}`;}
    if(n.type==="orderedList"&&(attrs.type==null||attrs.type==="1"))delete attrs.type;
    const marks=(n.marks??[]).flatMap(m=>{
      if(m.type==="link"){if(!safeUrl(String(m.attrs?.href)))return [];const attrs={...m.attrs};if(attrs.title==null)delete attrs.title;return [{...m,attrs}];}
      if(m.type==="textStyle"&&m.attrs?.color){const color=rgbToHex(String(m.attrs.color));return palette.includes(color)?[{type:m.type,attrs:{color}}]:[];}
      if(m.type==="highlight"&&m.attrs?.color){const color=rgbToHex(String(m.attrs.color));return highlights.includes(color)?[{type:m.type,attrs:{color}}]:[];}
      return [m];
    });
    return {...n,...(n.attrs?{attrs}:{}),...(n.marks?{marks}:{}),...(n.content?{content:n.content.map(walk)}:{})};
  }
  return ensureIds(walk(document));
}

