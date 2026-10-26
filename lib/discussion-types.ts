import type { Anchor,AnchorInput } from './comment-anchors';
export type DiscussionChange=
  | {kind:'create';operationId:string;body:string;mentionIds:string[];baseVersion:number;anchors:AnchorInput[]}
  | {kind:'reply';operationId:string;threadId:string;body:string;mentionIds:string[]}
  | {kind:'edit';operationId:string;commentId:string;expectedVersion:number;body:string;mentionIds:string[]}
  | {kind:'delete';operationId:string;commentId:string;expectedVersion:number}
  | {kind:'restore';operationId:string;commentId:string;expectedVersion:number}
  | {kind:'resolve';operationId:string;threadId:string;expectedVersion:number}
  | {kind:'reopen';operationId:string;threadId:string;expectedVersion:number};
export type CommentView={id:string;authorId:string;authorName:string;body:string|null;version:number;createdAt:string;editedAt:string|null;deletedAt:string|null;canEdit:boolean;canDelete:boolean;canRestore:boolean};
export type ThreadView={id:string;creatorId:string;status:'open'|'resolved';version:number;anchors:Anchor[];anchorUnavailable:boolean;createdAt:string;comments:CommentView[];canResolve:boolean};
