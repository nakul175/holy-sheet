import { z } from 'zod';
const common={operationId:z.string().uuid()};
export const templateCommandSchema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('save'),id:z.string().min(1).optional(),expectedDraftVersion:z.number().int().positive().optional(),name:z.string().max(100),description:z.string().max(500).default(''),category:z.string().trim().min(1).max(40).optional(),document:z.unknown().optional(),sourcePageId:z.string().min(1).optional(),sourcePageVersion:z.number().int().positive().optional()}).strict(),
 z.object({...common,kind:z.enum(['publish','archive']),id:z.string().min(1),expectedDraftVersion:z.number().int().positive()}).strict(),
 z.object({...common,kind:z.literal('publish-space'),id:z.string().min(1),expectedDraftVersion:z.number().int().positive(),spaceId:z.string().min(1),reviewed:z.literal(true),restricted:z.boolean().optional()}).strict(),
 z.object({...common,kind:z.literal('duplicate'),id:z.string().min(1),revision:z.number().int().positive(),name:z.string().trim().min(1).max(100)}).strict(),
 z.object({...common,kind:z.literal('instantiate'),id:z.string().min(1),revision:z.number().int().positive(),spaceId:z.string().min(1),title:z.string().max(240),variables:z.record(z.string().max(32),z.string().max(200)).optional(),records:z.record(z.string().max(32),z.string().uuid()).optional()}).strict(),
]);
