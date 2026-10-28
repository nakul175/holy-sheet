import type {FieldKind} from './shared-record-types';
export type RecordExportColumn={key:string;label:string;kind:FieldKind|'identity'};
export type RecordExportCell=string|number|boolean|null;
export type RecordExportTable={columns:RecordExportColumn[];rows:RecordExportCell[][]};
export class RecordExportError extends Error {}
export function portableRecordValue(kind:RecordExportColumn['kind'],value:unknown):RecordExportCell{
 if(value===undefined||value===null)return null;
 if(kind==='number'){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e15)throw new RecordExportError('A number cannot be represented safely.');return value;}
 if(kind==='boolean'){if(typeof value!=='boolean')throw new RecordExportError('Invalid boolean export value.');return value;}
 if(kind==='currency'){const v=value as {currency?:unknown;minorUnits?:unknown;scale?:unknown};if(!v||typeof v.currency!=='string'||!/^[A-Z]{3}$/.test(v.currency)||typeof v.minorUnits!=='string'||!/^\-?(0|[1-9]\d{0,17})$/.test(v.minorUnits)||!Number.isInteger(v.scale)||Number(v.scale)<0||Number(v.scale)>4)throw new RecordExportError('Invalid portable currency value.');return v.currency+':'+v.minorUnits+':'+v.scale;}
 if(['record','attachment','multi-select'].includes(kind)){if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'))throw new RecordExportError('Invalid portable ID/choice list.');return JSON.stringify(value);}
 if(typeof value!=='string'||Array.from(value).length>20000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF]/u.test(value))throw new RecordExportError('A text value cannot be represented safely.');return value;
}
export function spreadsheetRisk(value:string){return /^[\s\u0000-\u001f]*[=+\-@]/u.test(value)||/^[\t\r\n]/.test(value);}
export function csvRecordCell(value:RecordExportCell){const text=value===null?'':typeof value==='boolean'?value?'true':'false':String(value),safe=typeof value==='string'&&spreadsheetRisk(text)?"'"+text:text;return '"'+safe.replace(/"/g,'""')+'"';}
