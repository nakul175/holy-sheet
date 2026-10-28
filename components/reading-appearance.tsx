'use client';
import {useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Dialog} from './editor/dialog';
import {defaultReadingAppearance,readingAppearanceKey,readReadingAppearance,writeReadingAppearance,resetReadingAppearance,validReadingAppearance,type ReadingAppearance,type ReadingStorageFactory} from '../lib/reading-appearance';
import styles from './reading-appearance.module.css';
const browserStorage:ReadingStorageFactory=()=>window.localStorage;
export function useReadingAppearance(actorId:string,available:boolean,storage:ReadingStorageFactory=browserStorage){
 const [state,setState]=useState({actor:'',values:{...defaultReadingAppearance},persistent:true,invalid:false});
 const permitted=available&&readingAppearanceKey(actorId)!==null;
 useLayoutEffect(()=>{if(!permitted){setState({actor:'',values:{...defaultReadingAppearance},persistent:true,invalid:false});return;}setState({actor:actorId,...readReadingAppearance(actorId,storage)});},[actorId,permitted,storage]);
 const ready=permitted&&state.actor===actorId,values=ready?state.values:{...defaultReadingAppearance};
 function change(key:keyof ReadingAppearance,value:string){if(!ready)return;const next={...values,[key]:value};if(!validReadingAppearance(next))return;const persistent=state.persistent&&writeReadingAppearance(actorId,next,storage);setState({actor:actorId,values:next,persistent,invalid:false});}
 function reset(){if(!ready)return;const removed=resetReadingAppearance(actorId,storage);setState({actor:actorId,values:{...defaultReadingAppearance},persistent:state.persistent&&removed,invalid:false});}
 const articleClassName=ready?[styles.surface,values.textSize==='large'?styles.sizeLarge:values.textSize==='extra-large'?styles.sizeExtraLarge:'',values.lineSpacing==='relaxed'?styles.spacingRelaxed:'',values.pageWidth==='wide'?styles.widthWide:''].filter(Boolean).join(' '):'';
 return {ready,values,change,reset,articleClassName,scope:actorId+':'+permitted,notice:!state.persistent?'Changes apply to this session only. Browser storage is unavailable.':state.invalid?'Saved choices were not valid. Defaults are shown until you choose a setting.':'Choices stay with your account on this browser.'};
}
export function ReadingAppearanceControls({model}:{model:ReturnType<typeof useReadingAppearance>}){
 const [open,setOpen]=useState(false),opener=useRef<HTMLButtonElement>(null),hint=useId();
 function close(){setOpen(false);const button=opener.current;if(button?.isConnected){const details=button.closest('details');if(details)details.querySelector('summary')?.focus({preventScroll:true});else button.focus({preventScroll:true});}}
 return <><button type="button" ref={opener} disabled={!model.ready} aria-haspopup="dialog" aria-expanded={open&&model.ready} onClick={()=>setOpen(true)}>Reading appearance</button>{open&&model.ready&&createPortal(<div className={styles.controls}><Dialog title="Reading appearance" onClose={close}>
  <p id={hint}>Choose how this page reads for you. Document formatting stays unchanged.</p>
  <fieldset aria-describedby={hint}><legend>Personal reading preferences</legend>
   <label>Text size<select value={model.values.textSize} onChange={event=>model.change('textSize',event.target.value)}><option value="default">Default</option><option value="large">Large</option><option value="extra-large">Extra large</option></select></label>
   <label>Line spacing<select value={model.values.lineSpacing} onChange={event=>model.change('lineSpacing',event.target.value)}><option value="default">Default</option><option value="relaxed">Relaxed</option></select></label>
   <label>Page width<select value={model.values.pageWidth} onChange={event=>model.change('pageWidth',event.target.value)}><option value="default">Default</option><option value="wide">Wide</option></select></label>
  </fieldset>
  <p className={styles.hint}>Wide uses the available room. Narrow screens keep their safe margins.</p>
  <p role="status" className={styles.notice}>{model.notice}</p>
  <button type="button" className={styles.reset} onClick={model.reset}>Reset to defaults</button>
 </Dialog></div>,document.body)}</>;
}
