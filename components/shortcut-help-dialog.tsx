'use client';
import {useState} from 'react';
import {Dialog} from './editor/dialog';
import {filterShortcuts,shortcutKeyLabel,shortcutKeys,shortcutPlatform,type Shortcut} from '../lib/shortcut-help';

const groups=['Find','Formatting','Blocks'] as const;

export default function ShortcutHelpDialog({editable,onClose}:{editable:boolean;onClose:()=>void}){
 const [query,setQuery]=useState('');
 const platform=shortcutPlatform(typeof navigator==='undefined'?'':navigator.platform,typeof navigator==='undefined'?'':navigator.userAgent);
 const results=filterShortcuts(query);
 return <Dialog title="Keyboard shortcuts" onClose={onClose}>
  <p className="shortcut-intro">Shortcuts available on this page. This reference never runs an action.</p>
  {!editable&&<p className="shortcut-context" role="status"><strong>View-only page.</strong> Editing shortcuts are shown for reference and marked unavailable here.</p>}
  <label className="shortcut-search">Filter shortcuts<input autoFocus type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Try find, heading or bold" aria-controls="shortcut-results"/></label>
  <div id="shortcut-results" className="shortcut-results" aria-live="polite">
   {groups.map(group=>{const items=results.filter(item=>item.group===group);return items.length?<section key={group} aria-labelledby={`shortcut-${group.toLowerCase()}`}><h3 id={`shortcut-${group.toLowerCase()}`}>{group}</h3><ul>{items.map(item=><ShortcutRow key={item.id} item={item} platform={platform} available={editable||!item.editable}/>)}</ul></section>:null;})}
   {!results.length&&<p className="shortcut-empty">No shortcuts match that filter. Try an action such as find, bold or heading.</p>}
  </div>
 </Dialog>;
}

function ShortcutRow({item,platform,available}:{item:Shortcut;platform:'mac'|'other';available:boolean}){
 const keys=shortcutKeys(item,platform);
 return <li className={!available?'is-unavailable':undefined}><div><strong>{item.action}</strong><span>{item.description}</span>{!available&&<em>Editing only · unavailable in view-only mode</em>}</div><span className="shortcut-keys" role="img" aria-label={shortcutKeyLabel(keys)}>{keys.map((key,index)=><kbd aria-hidden="true" key={`${key}-${index}`}>{key}</kbd>)}</span></li>;
}
