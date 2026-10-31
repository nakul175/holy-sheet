export type RecordFollowState={following:boolean};

export function acceptedFollow(value:unknown):RecordFollowState|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(typeof row.following!=='boolean')return null;
 return {following:row.following};
}
