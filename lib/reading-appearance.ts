export type ReadingAppearance={textSize:'default'|'large'|'extra-large';lineSpacing:'default'|'relaxed';pageWidth:'default'|'wide'};
export const defaultReadingAppearance:Readonly<ReadingAppearance>=Object.freeze({textSize:'default',lineSpacing:'default',pageWidth:'default'});
export type ReadingStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type ReadingStorageFactory=()=>ReadingStorage;
export function readingAppearanceKey(actorId:string):string|null{
 if(typeof actorId!=='string'||!actorId||actorId.length>200||actorId.trim()!==actorId||/[\u0000-\u001f\u007f]/u.test(actorId))return null;
 try{return 'hs-reading:v1:'+encodeURIComponent(actorId);}catch{return null;}
}
export function validReadingAppearance(value:unknown):value is ReadingAppearance{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).length===3&&Object.keys(v).every(key=>['textSize','lineSpacing','pageWidth'].includes(key))&&typeof v.textSize==='string'&&typeof v.lineSpacing==='string'&&typeof v.pageWidth==='string'&&['default','large','extra-large'].includes(v.textSize)&&['default','relaxed'].includes(v.lineSpacing)&&['default','wide'].includes(v.pageWidth);
}
export function decodeReadingAppearance(raw:unknown):ReadingAppearance|null{
 if(typeof raw!=='string'||raw.length>512)return null;
 try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4||!Object.keys(value).every(key=>['version','textSize','lineSpacing','pageWidth'].includes(key))||value.version!==1)return null;const choices={textSize:value.textSize,lineSpacing:value.lineSpacing,pageWidth:value.pageWidth};return validReadingAppearance(choices)?choices:null;}catch{return null;}
}
export function readReadingAppearance(actorId:string,storage:ReadingStorageFactory){
 const fallback={...defaultReadingAppearance},key=readingAppearanceKey(actorId);
 if(!key)return {values:fallback,persistent:false,invalid:false};
 try{const raw=storage().getItem(key);if(raw===null)return {values:fallback,persistent:true,invalid:false};const values=decodeReadingAppearance(raw);return {values:values??fallback,persistent:true,invalid:values===null};}catch{return {values:fallback,persistent:false,invalid:false};}
}
export function writeReadingAppearance(actorId:string,values:ReadingAppearance,storage:ReadingStorageFactory):boolean{
 const key=readingAppearanceKey(actorId);if(!key||!validReadingAppearance(values))return false;
 try{storage().setItem(key,JSON.stringify({version:1,textSize:values.textSize,lineSpacing:values.lineSpacing,pageWidth:values.pageWidth}));return true;}catch{return false;}
}
export function resetReadingAppearance(actorId:string,storage:ReadingStorageFactory):boolean{
 const key=readingAppearanceKey(actorId);if(!key)return false;
 try{storage().removeItem(key);return true;}catch{return false;}
}
