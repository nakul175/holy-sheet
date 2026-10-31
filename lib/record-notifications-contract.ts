export type RecordNotificationReason='mention'|'follow';
export type RecordNotification={
 id:string;recordId:string;recordName:string;commentId:string;body:string;authorName:string;
 reason:RecordNotificationReason;createdAt:string;readAt:string|null;
};
export type RecordNotificationList={notifications:RecordNotification[]};

function notification(value:unknown):RecordNotification|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(typeof row.id!=='string'||typeof row.recordId!=='string'||typeof row.recordName!=='string'||typeof row.commentId!=='string'||typeof row.body!=='string'||typeof row.authorName!=='string')return null;
 if(row.reason!=='mention'&&row.reason!=='follow'||typeof row.createdAt!=='string'||!(row.readAt===null||typeof row.readAt==='string'))return null;
 return {id:row.id,recordId:row.recordId,recordName:row.recordName,commentId:row.commentId,body:row.body,authorName:row.authorName,reason:row.reason,createdAt:row.createdAt,readAt:row.readAt};
}

export function acceptedRecordNotifications(value:unknown):RecordNotificationList|null{
 if(!value||typeof value!=='object'||!Array.isArray((value as {notifications?:unknown}).notifications))return null;
 const notifications:RecordNotification[]=[];
 for(const item of (value as {notifications:unknown[]}).notifications){const parsed=notification(item);if(!parsed)return null;notifications.push(parsed);}
 return {notifications};
}

export function recordNotificationLabel(reason:RecordNotificationReason){
 return reason==='mention'?'Mentioned you':'New comment on a followed record';
}
