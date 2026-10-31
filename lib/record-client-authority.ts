import {z} from 'zod';
import {DocumentError} from './document';
import type {CurrentRecordClientAuthority} from './shared-record-api';

const denied=()=>new DocumentError('Current application delegation is unavailable.','record_client_denied',403);
const published=z.object({
 apiVersion:z.literal(1),
 data:z.unknown(),
 authority:z.object({verifiedAt:z.string().min(1).max(40),validUntil:z.string().min(1).max(40)}).strict(),
 cacheControl:z.literal('private, no-store'),
 offline:z.literal(false),
}).strict();

/** Production delegation verifier. No token, body, app or tenant claim is accepted. */
export function unavailableRecordClientAuthority():CurrentRecordClientAuthority{
 return {verify:async()=>{throw denied();}};
}

/** Publishes a version-one command result only when it is online and uncacheable. */
export function publishRecordClientResult(result:unknown){
 const parsed=published.safeParse(result);
 if(!parsed.success)throw new DocumentError('Service temporarily unavailable.','service_unavailable',503);
 return parsed.data;
}
