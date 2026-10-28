export type ShortcutPlatform='mac'|'other';
export type Shortcut={id:string;group:'Find'|'Formatting'|'Blocks';action:string;description:string;mac:string[];other:string[];editable:boolean};

export const shortcuts:Shortcut[]=[
 {id:'find-page',group:'Find',action:'Find in this page',description:'Search the open page without changing it.',mac:['⌘','F'],other:['Ctrl','F'],editable:false},
 {id:'bold',group:'Formatting',action:'Bold',description:'Toggle bold on the selection.',mac:['⌘','B'],other:['Ctrl','B'],editable:true},
 {id:'italic',group:'Formatting',action:'Italic',description:'Toggle italic on the selection.',mac:['⌘','I'],other:['Ctrl','I'],editable:true},
 {id:'underline',group:'Formatting',action:'Underline',description:'Toggle underline on the selection.',mac:['⌘','U'],other:['Ctrl','U'],editable:true},
 {id:'strike',group:'Formatting',action:'Strikethrough',description:'Toggle strikethrough on the selection.',mac:['⌘','Shift','S'],other:['Ctrl','Shift','S'],editable:true},
 {id:'link',group:'Formatting',action:'Edit link',description:'Open link editing for selected or linked text.',mac:['⌘','K'],other:['Ctrl','K'],editable:true},
 {id:'clear',group:'Formatting',action:'Clear formatting',description:'Remove inline formatting from the selection.',mac:['⌘','\\'],other:['Ctrl','\\'],editable:true},
 {id:'plain-paste',group:'Formatting',action:'Paste without formatting',description:'Paste clipboard text literally.',mac:['⌘','Shift','V'],other:['Ctrl','Shift','V'],editable:true},
 {id:'paragraph',group:'Blocks',action:'Paragraph',description:'Convert the current text block to paragraph text.',mac:['⌘','⌥','0'],other:['Ctrl','Alt','0'],editable:true},
 {id:'heading-1',group:'Blocks',action:'Heading 1',description:'Convert the current text block to heading 1.',mac:['⌘','⌥','1'],other:['Ctrl','Alt','1'],editable:true},
 {id:'heading-2',group:'Blocks',action:'Heading 2',description:'Convert the current text block to heading 2.',mac:['⌘','⌥','2'],other:['Ctrl','Alt','2'],editable:true},
 {id:'heading-3',group:'Blocks',action:'Heading 3',description:'Convert the current text block to heading 3.',mac:['⌘','⌥','3'],other:['Ctrl','Alt','3'],editable:true},
 {id:'numbered',group:'Blocks',action:'Numbered list',description:'Convert the current text block to a numbered item.',mac:['⌘','Shift','7'],other:['Ctrl','Shift','7'],editable:true},
 {id:'bulleted',group:'Blocks',action:'Bulleted list',description:'Convert the current text block to a bulleted item.',mac:['⌘','Shift','8'],other:['Ctrl','Shift','8'],editable:true},
 {id:'checklist',group:'Blocks',action:'Checklist',description:'Convert the current text block to a checklist item.',mac:['⌘','Shift','9'],other:['Ctrl','Shift','9'],editable:true},
 {id:'quote',group:'Blocks',action:'Quote',description:'Convert the current text block to a quote.',mac:['⌘','Shift','B'],other:['Ctrl','Shift','B'],editable:true},
];

export function shortcutPlatform(platform='',userAgent=''):ShortcutPlatform{return /mac|iphone|ipad|ipod/i.test(platform||userAgent)?'mac':'other';}
export function shortcutKeys(shortcut:Shortcut,platform:ShortcutPlatform){return platform==='mac'?shortcut.mac:shortcut.other;}
export function shortcutKeyLabel(keys:string[]){const names:Record<string,string>={'⌘':'Command','⌥':'Option','\\':'Backslash'};return keys.map(key=>names[key]??key).join(' plus ');}
export function filterShortcuts(query:string){const value=query.trim().toLocaleLowerCase();return shortcuts.filter(shortcut=>!value||[shortcut.group,shortcut.action,shortcut.description,...shortcut.mac,...shortcut.other].join(' ').toLocaleLowerCase().includes(value));}
