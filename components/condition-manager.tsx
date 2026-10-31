'use client';
import {useEffect,useState} from 'react';
import styles from './condition-manager.module.css';

type Field={key:string;label:string;kind:string;required:boolean;choices:string[]};
type Operator='is-empty'|'is-not-empty'|'equals'|'not-equals'|'greater-than'|'less-than'|'contains-any'|'contains-all';
type Clause={field:string;operator:Operator;value?:unknown};
type Group={all:Clause[]}|{any:Clause[]};
type Rule={id:string;target:string;showWhen?:Group;requiredWhen?:Group};
type Preview={previewId:string;reviewHash:string;blocked:boolean;existingRecordsReviewed:number;incompatibleRecords:number;draftsReady:boolean};

const operators:Operator[]=['is-empty','is-not-empty','equals','not-equals','greater-than','less-than','contains-any','contains-all'];
const referenceKinds=new Set(['record','attachment']);

function clausesOf(group?:Group){return !group?[]:'any' in group?group.any:group.all;}
function modeOf(group?:Group):'all'|'any'{return group&&'any' in group?'any':'all';}
function asGroup(mode:'all'|'any',clauses:Clause[]):Group{return mode==='any'?{any:clauses}:{all:clauses};}
function cleanClause(clause:Clause):Clause{if(clause.operator==='is-empty'||clause.operator==='is-not-empty')return {field:clause.field,operator:clause.operator};return clause;}
function cleanGroup(group?:Group){if(!group)return undefined;return asGroup(modeOf(group),clausesOf(group).map(cleanClause));}
function forServer(rule:Rule):Rule{const cleaned=cleanGroup(rule.showWhen??rule.requiredWhen);if(!cleaned)return {id:rule.id,target:rule.target};return {id:rule.id,target:rule.target,...(rule.showWhen?{showWhen:cleaned}:{}),...(rule.requiredWhen?{requiredWhen:cleaned}:{})};}
function sourcesFor(fields:Field[],target:string){return fields.filter(field=>field.key!==target&&!referenceKinds.has(field.kind));}
function operatorsFor(kind:string){return operators.filter(operator=>operator==='greater-than'||operator==='less-than'?kind==='number'||kind==='date':operator==='contains-any'||operator==='contains-all'?kind==='multi-select':true);}
function blankClause(field:Field):Clause{return {field:field.key,operator:'is-not-empty'};}
function valueText(field:Field|undefined,value:unknown){if(Array.isArray(value))return value.join(', ');if(typeof value==='boolean')return value?'true':'false';if(field?.kind==='currency'&&value&&typeof value==='object')return '';if(value===undefined||value===null)return '';return String(value);}
function typedScalar(field:Field|undefined,raw:string){if(field?.kind==='number')return Number(raw);if(field?.kind==='boolean')return raw==='true';if(field?.kind==='multi-select')return raw.split(',').map(item=>item.trim()).filter(Boolean);return raw;}
function currencyValue(value:unknown){const current=value&&typeof value==='object'?value as {currency?:string;minorUnits?:string;scale?:number}:{};return {currency:current.currency??'',minorUnits:current.minorUnits??'',scale:typeof current.scale==='number'?current.scale:2};}

export default function ConditionManager({workspaceId,tenantId,collection}:{workspaceId:string;tenantId:string;collection:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-conditions`;
 const [fields,setFields]=useState<Field[]>([]);
 const [rules,setRules]=useState<Rule[]>([]);
 const [version,setVersion]=useState(0);
 const [schemaVersion,setSchemaVersion]=useState(1);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);
 const divergent=rules.some(rule=>rule.showWhen&&rule.requiredWhen&&JSON.stringify(rule.showWhen)!==JSON.stringify(rule.requiredWhen));

 async function call(body?:unknown){
  const response=await fetch(body?base:`${base}?collection=${encodeURIComponent(collection)}`,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const payload=await response.json();
  if(!response.ok)throw Error(payload.error??'Conditional policy request failed.');
  return payload;
 }
 async function load(){
  setBusy(true);
  try{const payload=await call();setFields(payload.fields);setRules(payload.rules);setVersion(payload.version);setSchemaVersion(payload.schemaVersion);}
  catch(cause){setError(cause instanceof Error?cause.message:'Unable to load conditional fields.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();},[base]);

 function edit(index:number,recipe:(rule:Rule)=>Rule){setPreview(null);setRules(current=>current.map((rule,ruleIndex)=>ruleIndex===index?recipe(rule):rule));}
 function rewrite(index:number,show:boolean,required:boolean,next?:Group){edit(index,rule=>({...rule,showWhen:show?next:undefined,requiredWhen:required?next:undefined}));}
 const selection={collection,expectedVersion:version,expectedSchemaVersion:schemaVersion,rules:rules.map(forServer)};

 function addRule(){
  const target=fields.find(field=>!field.required)??fields[0];
  const source=target?sourcesFor(fields,target.key)[0]:undefined;
  if(!target||!source||rules.length>=20)return;
  const next=asGroup('all',[blankClause(source)]);
  setPreview(null);
  setRules(current=>[...current,{id:crypto.randomUUID(),target:target.key,showWhen:target.required?undefined:next,requiredWhen:target.required?next:undefined}]);
 }

 async function review(){
  setBusy(true);setError('');setNotice('');
  try{setPreview(await call({kind:'preview',selection}));}
  catch(cause){setError(cause instanceof Error?cause.message:'Unable to review policy.');}
  finally{setBusy(false);}
 }
 async function publish(){
  if(!preview||preview.blocked)return;
  setBusy(true);setError('');
  try{
   const payload=await call({kind:'publish',previewId:preview.previewId,reviewHash:preview.reviewHash,operationId:crypto.randomUUID(),confirm:'publish-conditional-policy',selection});
   setVersion(payload.version);setSchemaVersion(current=>current+1);setPreview(null);setNotice('Conditional policy published. Hidden values are retained until explicitly cleared.');
  }catch(cause){setError(cause instanceof Error?cause.message:'Unable to publish policy.');}
  finally{setBusy(false);}
 }

 return <main className={styles.root}>
  <h1>Conditional fields</h1>
  <p className={styles.intro}>Show or require a field from typed comparisons: equality, empty or not empty, number or date ranges, and multi-select containment. Combine up to five comparisons with all or any. This is not a formula. Hiding a field keeps its stored value until an explicit permitted edit clears it. A field that is always required cannot be hidden.</p>
  {error&&<p className={styles.alert} role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {divergent&&<p className={styles.alert} role="alert">Show and require must use the same comparison. Edit the rule before review.</p>}
  <fieldset disabled={busy}><legend>Rules</legend>
   {rules.map((rule,index)=>{
    const active=rule.showWhen??rule.requiredWhen;
    const mode=modeOf(active);
    const clauses=clausesOf(active);
    const target=fields.find(field=>field.key===rule.target);
    const show=!!rule.showWhen;
    const required=!!rule.requiredWhen;
    return <section className={styles.rule} key={rule.id} aria-label={`Rule ${index+1}`}>
     <div className={styles.row}>
      <label>Target field <select aria-label={`Rule ${index+1} target`} value={rule.target} onChange={event=>{const nextTarget=fields.find(field=>field.key===event.target.value);const nextShow=!!nextTarget&&!nextTarget.required&&show;edit(index,()=>({...rule,target:event.target.value,showWhen:nextShow?active:undefined,requiredWhen:(required||!nextShow)?active:undefined}));}}>{fields.map(field=><option key={field.key} value={field.key}>{field.label}</option>)}{target?null:<option value={rule.target}>{rule.target}</option>}</select></label>
      <label className={styles.check}><input aria-label={`Rule ${index+1} show`} type="checkbox" checked={show&&!target?.required} disabled={!!target?.required} onChange={event=>{if(!required&&!event.target.checked)return;rewrite(index,event.target.checked,required,active);}}/> Show conditionally</label>
      <label className={styles.check}><input aria-label={`Rule ${index+1} require`} type="checkbox" checked={required} onChange={event=>{if(!show&&!event.target.checked)return;rewrite(index,show&&!target?.required,event.target.checked,active);}}/> Require conditionally</label>
      <label>Match <select aria-label={`Rule ${index+1} match`} value={mode} onChange={event=>rewrite(index,show&&!target?.required,required,asGroup(event.target.value==='any'?'any':'all',clauses))}><option value="all">all comparisons</option><option value="any">any comparison</option></select></label>
     </div>
     {clauses.map((clause,clauseIndex)=>{
      const source=fields.find(field=>field.key===clause.field);
      const choices=operatorsFor(source?.kind??'text');
      const needsValue=clause.operator!=='is-empty'&&clause.operator!=='is-not-empty';
      const currency=currencyValue(clause.value);
      return <div className={styles.row} key={`${rule.id}-${clauseIndex}`}>
       <label>Source field <select aria-label={`Rule ${index+1} comparison ${clauseIndex+1} source`} value={clause.field} onChange={event=>{const nextField=fields.find(field=>field.key===event.target.value);const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?blankClause(nextField??{key:event.target.value,label:event.target.value,kind:'text',required:false,choices:[]}):item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}>{sourcesFor(fields,rule.target).map(field=><option key={field.key} value={field.key}>{field.label}</option>)}{source?null:<option value={clause.field}>{clause.field}</option>}</select></label>
       <label>Comparison <select aria-label={`Rule ${index+1} comparison ${clauseIndex+1} operator`} value={clause.operator} onChange={event=>{const operator=event.target.value as Operator;const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?operator==='is-empty'||operator==='is-not-empty'?{field:item.field,operator}:item.operator==='is-empty'||item.operator==='is-not-empty'?{field:item.field,operator,value:source?.kind==='boolean'?false:source?.kind==='number'?0:source?.kind==='multi-select'?[]:source?.kind==='currency'?{currency:'USD',minorUnits:'0',scale:2}:''}:{...item,operator}:item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}>{choices.map(operator=><option key={operator} value={operator}>{operator}</option>)}</select></label>
       {needsValue&&source?.kind==='boolean'&&<label>Value <select aria-label={`Rule ${index+1} comparison ${clauseIndex+1} value`} value={clause.value===true?'true':'false'} onChange={event=>{const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?{...item,value:event.target.value==='true'}:item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}><option value="true">true</option><option value="false">false</option></select></label>}
       {needsValue&&source?.kind==='currency'&&<>
        <label>Currency code <input aria-label={`Rule ${index+1} comparison ${clauseIndex+1} currency`} value={currency.currency} maxLength={3} onChange={event=>{const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?{...item,value:{...currency,currency:event.target.value.toUpperCase()}}:item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}/></label>
        <label>Minor units <input aria-label={`Rule ${index+1} comparison ${clauseIndex+1} minor units`} value={currency.minorUnits} onChange={event=>{const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?{...item,value:{...currency,minorUnits:event.target.value}}:item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}/></label>
        <label>Scale <input aria-label={`Rule ${index+1} comparison ${clauseIndex+1} scale`} type="number" min={0} max={4} value={currency.scale} onChange={event=>{const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?{...item,value:{...currency,scale:Number(event.target.value)}}:item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}/></label>
       </>}
       {needsValue&&source?.kind!=='boolean'&&source?.kind!=='currency'&&<label>Value <input aria-label={`Rule ${index+1} comparison ${clauseIndex+1} value`} type={source?.kind==='number'?'number':source?.kind==='date'?'date':'text'} value={valueText(source,clause.value)} aria-describedby={source?.kind==='multi-select'?`multi-help-${index}-${clauseIndex}`:undefined} onChange={event=>{const next=clauses.map((item,itemIndex)=>itemIndex===clauseIndex?{...item,value:typedScalar(source,event.target.value)}:item);rewrite(index,show&&!target?.required,required,asGroup(mode,next));}}/></label>}
       {source?.kind==='multi-select'&&<small className={styles.help} id={`multi-help-${index}-${clauseIndex}`}>Separate selected values with commas.</small>}
       <button type="button" disabled={clauses.length<=1} onClick={()=>rewrite(index,show&&!target?.required,required,asGroup(mode,clauses.filter((_,itemIndex)=>itemIndex!==clauseIndex)))}>Remove comparison</button>
      </div>;
     })}
     <div className={styles.actions}><button type="button" disabled={clauses.length>=5||!sourcesFor(fields,rule.target).length} onClick={()=>{const source=sourcesFor(fields,rule.target)[0];if(source)rewrite(index,show&&!target?.required,required,asGroup(mode,[...clauses,blankClause(source)]));}}>Add comparison</button><button type="button" onClick={()=>{setPreview(null);setRules(current=>current.filter((_,ruleIndex)=>ruleIndex!==index));}}>Remove rule</button></div>
    </section>;
   })}
   <button type="button" disabled={!fields.length||rules.length>=20} onClick={addRule}>Add rule</button>
  </fieldset>
  <p className={styles.meta}>Policy {version} · schema {schemaVersion}</p>
  <div className={styles.actions}><button type="button" disabled={busy||divergent||!rules.length} onClick={()=>void review()}>Review policy</button></div>
  {preview&&<section className={styles.preview} aria-label="Policy confirmation"><h2>Publication review</h2><p>{preview.existingRecordsReviewed} records reviewed; {preview.incompatibleRecords} incompatible. Connected drafts {preview.draftsReady?'are quiescent':'are not yet qualified'}.</p>{preview.blocked?<p role="alert">Publication is blocked until records and connected drafts are safe.</p>:<button type="button" disabled={busy} onClick={()=>void publish()}>Publish reviewed policy</button>}</section>}
 </main>;
}
