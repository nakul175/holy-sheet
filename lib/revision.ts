import { createHash } from 'node:crypto';
import { stableStringify,schemaVersion,type RichNode } from './document';
export function revisionDigest(title:string,document:RichNode,version=schemaVersion){return createHash('sha256').update(stableStringify([version,title,document])).digest('hex');}
