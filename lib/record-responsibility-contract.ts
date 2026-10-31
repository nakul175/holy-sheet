export type RecordResponsibilityPerson={id:string;name:string};
export type RecordHandoverPending={id:string;from:RecordResponsibilityPerson;to:RecordResponsibilityPerson;createdAt:string};
export type RecordResponsibilityState={
 responsible:RecordResponsibilityPerson|null;
 pending:RecordHandoverPending|null;
 canOffer:boolean;
 canAccept:boolean;
 canCancel:boolean;
};

function person(value:unknown):RecordResponsibilityPerson|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(typeof row.id!=='string'||!row.id||row.id.length>200||typeof row.name!=='string'||!row.name||row.name.length>200)return null;
 return {id:row.id,name:row.name};
}

export function acceptedResponsibility(value:unknown):RecordResponsibilityState|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(typeof row.canOffer!=='boolean'||typeof row.canAccept!=='boolean'||typeof row.canCancel!=='boolean')return null;
 if(row.responsible!==null&&!person(row.responsible))return null;
 const responsible=row.responsible===null?null:person(row.responsible);
 let pending:RecordHandoverPending|null=null;
 if(row.pending!==null){
  if(!row.pending||typeof row.pending!=='object')return null;
  const item=row.pending as Record<string,unknown>;
  const from=person(item.from),to=person(item.to);
  if(typeof item.id!=='string'||!item.id||typeof item.createdAt!=='string'||!item.createdAt||!from||!to)return null;
  pending={id:item.id,from,to,createdAt:item.createdAt};
 }
 return {responsible,pending,canOffer:row.canOffer,canAccept:row.canAccept,canCancel:row.canCancel};
}

export function acceptedResponsibilityPeople(value:unknown):RecordResponsibilityPerson[]|null{
 if(!value||typeof value!=='object'||!Array.isArray((value as {people?:unknown}).people))return null;
 const people:RecordResponsibilityPerson[]=[];
 for(const item of (value as {people:unknown[]}).people){
  const parsed=person(item);
  if(!parsed)return null;
  people.push(parsed);
 }
 return people;
}
