import type { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';

function inlineText(node:PMNode):string{
  if(node.isText)return node.text??'';
  if(node.type.name==='hardBreak')return '\n';
  return Array.from({length:node.childCount},(_,index)=>inlineText(node.child(index))).join('');
}

function blockText(node:PMNode):string{
  if(node.type.name==='paragraph')return inlineText(node);
  if(node.type.name==='taskItem'){
    const marker=node.attrs.checked?'[x] ':'[ ] ';
    return marker+Array.from({length:node.childCount},(_,index)=>blockText(node.child(index))).filter(Boolean).join('\n');
  }
  if(node.type.name==='taskList')return Array.from({length:node.childCount},(_,index)=>blockText(node.child(index))).filter(Boolean).join('\n');
  return inlineText(node);
}

/** Keep every logical table cell on one TSV line without losing its text. */
export function escapeTablePlainText(value:string):string{
  return value.replace(/\\/g,'\\\\').replace(/\r\n?|\n/g,'\\n').replace(/\t/g,'\\t');
}

export function tableCellPlainText(cell:PMNode):string{
  return escapeTablePlainText(Array.from({length:cell.childCount},(_,index)=>blockText(cell.child(index))).join('\n'));
}

/** Serialize the complete logical table; covered merged-cell coordinates are empty. */
export function serializeTablePlainText(table:PMNode):string{
  if(table.type.name!=='table')throw new Error('Choose a table before copying.');
  const map=TableMap.get(table);
  if(map.height>100||map.width>20)throw new Error('Tables support at most 100 rows and 20 columns.');
  const emitted=new Set<number>(),rows:string[]=[];
  for(let row=0;row<map.height;row++){
    const cells:string[]=[];
    for(let column=0;column<map.width;column++){
      const position=map.map[row*map.width+column];
      if(emitted.has(position)){cells.push('');continue;}
      emitted.add(position);
      const cell=table.nodeAt(position);
      if(!cell||!['tableCell','tableHeader'].includes(cell.type.name))throw new Error('The current table structure is unavailable.');
      cells.push(tableCellPlainText(cell));
    }
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}
