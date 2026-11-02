import type { Anchor,AnchorInput } from './comment-anchors';
type Mentioned={mentionIds:string[];recordMentionIds?:string[]};
export type DiscussionChange=
  | ({kind:'create';operationId:string;body:string;baseVersion:number;anchors:AnchorInput[]}&Mentioned)
  | ({kind:'reply';operationId:string;threadId:string;body:string}&Mentioned)
  | ({kind:'edit';operationId:string;commentId:string;expectedVersion:number;body:string}&Mentioned)
  | {kind:'delete';operationId:string;commentId:string;expectedVersion:number}
  | {kind:'restore';operationId:string;commentId:string;expectedVersion:number}
  | {kind:'resolve';operationId:string;threadId:string;expectedVersion:number}
  | {kind:'reopen';operationId:string;threadId:string;expectedVersion:number};
export type CommentRecordChip={id:string;status:'visible'|'restricted';title:string|null;href:string|null};
export type CommentView={id:string;authorId:string;authorName:string;body:string|null;version:number;createdAt:string;editedAt:string|null;deletedAt:string|null;canEdit:boolean;canDelete:boolean;canRestore:boolean;records:CommentRecordChip[]};
export type ThreadActivity={kind:'resolved'|'reopened';actorName:string;at:string;atIst:string;label:string};
export type ThreadView={id:string;creatorId:string;status:'open'|'resolved';version:number;anchors:Anchor[];anchorUnavailable:boolean;createdAt:string;comments:CommentView[];canResolve:boolean;mine:boolean;mentionsMe:boolean;activity:ThreadActivity[]};
