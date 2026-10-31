export type RecordCommentMention={id:string;name:string};
export type RecordComment={id:string;authorId:string;authorName:string;body:string;createdAt:string;mentions:RecordCommentMention[]};
export type RecordCommentList={comments:RecordComment[];truncated:boolean};

/** A mention token is the member's current name. Names that cannot form one stable token are not mentionable. */
export function bodyIncludesMention(body:string,name:string){
 return name.length>0&&name===name.trim()&&!name.includes('@')&&!/[\u0000\r\n]/.test(name)&&body.includes(`@${name}`);
}

export function commentBodyParts(body:string,mentions:readonly RecordCommentMention[]){
 const names=mentions.filter(person=>bodyIncludesMention(body,person.name)).sort((a,b)=>b.name.length-a.name.length||a.id.localeCompare(b.id));
 const parts:{text:string;mentionId?:string}[]=[];
 let index=0;
 while(index<body.length){
  if(body[index]==='@'){
   const match=names.find(person=>body.startsWith(`@${person.name}`,index));
   if(match){parts.push({text:`@${match.name}`,mentionId:match.id});index+=match.name.length+1;continue;}
  }
  const next=body.indexOf('@',index+1),end=next<0?body.length:next;
  parts.push({text:body.slice(index,end)});
  index=end;
 }
 return parts;
}

export function acceptedComment(value:unknown):RecordComment|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(typeof row.id!=='string'||typeof row.authorId!=='string'||typeof row.authorName!=='string'||typeof row.body!=='string'||typeof row.createdAt!=='string'||!Array.isArray(row.mentions))return null;
 const mentions:RecordCommentMention[]=[];
 for(const mention of row.mentions){
  if(!mention||typeof mention!=='object')return null;
  const item=mention as Record<string,unknown>;
  if(typeof item.id!=='string'||typeof item.name!=='string')return null;
  mentions.push({id:item.id,name:item.name});
 }
 return {id:row.id,authorId:row.authorId,authorName:row.authorName,body:row.body,createdAt:row.createdAt,mentions};
}

export function acceptedCommentList(value:unknown):RecordCommentList|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(!Array.isArray(row.comments)||typeof row.truncated!=='boolean')return null;
 const comments:RecordComment[]=[];
 for(const item of row.comments){const comment=acceptedComment(item);if(!comment)return null;comments.push(comment);}
 return {comments,truncated:row.truncated};
}

export function acceptedMentionPeople(value:unknown):RecordCommentMention[]|null{
 if(!value||typeof value!=='object'||!Array.isArray((value as {people?:unknown}).people))return null;
 const people:RecordCommentMention[]=[];
 for(const person of (value as {people:unknown[]}).people){
  if(!person||typeof person!=='object')return null;
  const item=person as Record<string,unknown>;
  if(typeof item.id!=='string'||typeof item.name!=='string')return null;
  people.push({id:item.id,name:item.name});
 }
 return people;
}
