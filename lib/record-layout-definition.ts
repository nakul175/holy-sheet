import {z} from 'zod';
const label=z.string().trim().min(1).max(100).refine(v=>!/[\p{Cc}]/u.test(v));
const slot=z.object({field:z.string().min(1).max(100),mode:z.enum(['edit','read']).default('edit')}).strict();
const section=z.object({id:z.string().uuid(),label,description:z.string().max(500).default(''),columns:z.union([z.literal(1),z.literal(2)]).default(1),fields:z.array(slot).min(1).max(110)}).strict();
export const recordLayoutDefinition=z.object({tabs:z.array(z.object({id:z.string().uuid(),label,sections:z.array(section).min(1).max(20)}).strict()).min(1).max(10)}).strict().superRefine((d,c)=>{const sections=d.tabs.flatMap(t=>t.sections),fields=sections.flatMap(s=>s.fields),ids=[...d.tabs.map(t=>t.id),...sections.map(s=>s.id)];if(sections.length>20||fields.length>110||new Set(ids).size!==ids.length||new Set(fields.map(f=>f.field)).size!==fields.length)c.addIssue({code:'custom',message:'Use distinct layout IDs and field positions within the layout budget.'});});
export type RecordLayoutDefinition=z.infer<typeof recordLayoutDefinition>;
export const layoutSlots=(d:RecordLayoutDefinition)=>d.tabs.flatMap(t=>t.sections.flatMap(s=>s.fields));
export const editableLayoutField=(d:RecordLayoutDefinition,key:string)=>layoutSlots(d).some(s=>s.field===key&&s.mode==='edit');
export function projectRecordLayout(d:RecordLayoutDefinition,visible:ReadonlySet<string>):RecordLayoutDefinition{return {tabs:d.tabs.map(t=>({...t,sections:t.sections.map(s=>({...s,fields:s.fields.filter(f=>visible.has(f.field))})).filter(s=>s.fields.length)})).filter(t=>t.sections.length)};}
