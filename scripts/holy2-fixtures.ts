/** Deterministic fixture plan only. This module never connects to a database. */
import type {Page} from '../lib/types';
export const holy2Seed='holy2-20261028-v1';
export const holy2Readers=Array.from({length:5},(_,i)=>`${holy2Seed}-reader-${i}`);
export function fixtureAllowed(index:number,reader:number,total=10000){const boundary=Math.floor(total*.8);return index<boundary||Math.floor((index-boundary)/11)%5===reader;}
export function* holy2Pages(w1=10_000,w2=2_000):Generator<Page>{
 for(const [workspace,count] of [['w1',w1],['w2',w2]] as const){
  for(let i=0;i<count;i++){
   const key=String(i).padStart(5,'0'),workspaceId=`${holy2Seed}-${workspace}`,id=`${workspaceId}-page-${key}`;
   const blocks=Array.from({length:20},(_,b)=>({id:`${id}-block-${b}`,pageId:id,parentBlockId:null,type:(['paragraph','heading','bullet','number','checklist'] as const)[b%5],text:(`fixture${key} launch budget review section${b} `+'controlled synthetic text '.repeat(20)).slice(0,410),position:b}));
   // Independent chains of 11 records cover every depth 0–10, within a space.
   const partitionIndex=i<Math.floor(count*.8)?i:i-Math.floor(count*.8);
   const chainPosition=partitionIndex%11,parentPageId=chainPosition?`${workspaceId}-page-${String(i-1).padStart(5,'0')}`:null;
   yield {id,workspaceId,workspaceName:workspace==='w1'?'HOLY-2 synthetic W1':'HOLY-2 synthetic W2',spaceId:`${workspaceId}-space-${Math.floor(partitionIndex/11)%10}`,spaceName:Math.floor(partitionIndex/11)%10===0?'Marketing':'Finance '+(Math.floor(partitionIndex/11)%10),parentPageId,title:`Launch budget fixture${key}`,visibility:'private',version:1,updatedAt:new Date(Date.UTC(2026,9,28,0,0,i)).toISOString(),blocks};
  }
 }
}
export function holy2Queries(){return Array.from({length:100},(_,i)=>{
 const key=String((i%20)*499).padStart(5,'0'),kind=['exact-title','phrase','multiword','prefix','no-result'][Math.floor(i/20)];
 const query=kind==='exact-title'?`Launch budget fixture${key}`:kind==='phrase'?(i%5===0?'"launch budget"':`"launch budget" fixture${key}`):kind==='multiword'?`fixture${key} review`:kind==='prefix'?(i%5===0?'budg':`fixture${key} budg`):`absentfixture${key}`;
 return {kind,query,reader:i%5,workspaceId:`${holy2Seed}-w1`};
});}
