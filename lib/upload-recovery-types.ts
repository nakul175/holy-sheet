import { z } from 'zod';
import type { DraftProtection } from './recovery-client';
const placement=z.object({kind:z.enum(['after','replace']),blockId:z.string().min(1).max(100),expected:z.string().max(25_000_000),expectedHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),type:z.enum(['image','file']),attachmentId:z.string().uuid().optional(),alt:z.string().max(2048).optional(),caption:z.string().max(2048).optional(),insertId:z.string().uuid().optional()}).strict();
export const uploadCheckpointSchema=z.object({schema:z.literal(1),type:z.enum(['image','file']),name:z.string().min(1).max(240),size:z.number().int().positive().max(25_000_000),alt:z.string().max(2048),caption:z.string().max(2048),target:placement,phase:z.enum(['selected','reserved','processing','ready']),attempt:z.object({operationId:z.string().uuid(),name:z.string().max(240),size:z.number().int().positive(),replacedId:z.string().uuid().optional(),recoveryDraftId:z.string().uuid().optional(),id:z.string().uuid().optional()}).strict().optional(),fileHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export type UploadCheckpoint=z.infer<typeof uploadCheckpointSchema>;
export type RecoveredUpload={recordId:string;protection:DraftProtection;payload:UploadCheckpoint;lastRenewal?:number;release?:()=>Promise<void>;newPlacement?:boolean};
export const activeUploadRecoveries=new Set<string>();
export function notifyUploadRecovery(pageId:string){if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('holy-sheet:upload-recovery',{detail:{pageId}}));}
