'use client';
import { useEffect,useId,useRef,useState } from 'react';
import { codePositionAnnouncement,codePositionText,type CodePosition } from './code-position';

export function CodePositionStatus({position,contextKey}:{position:CodePosition|null;contextKey:string}){
  const descriptionId=useId(),last=useRef('');
  const [announced,setAnnounced]=useState({key:'',text:''});
  const summary=codePositionAnnouncement(position),key=summary.key?JSON.stringify([contextKey,summary.key]):'';
  useEffect(()=>{
    if(!key){last.current='';setAnnounced({key:'',text:''});return;}
    if(last.current===key)return;
    const timer=setTimeout(()=>{last.current=key;setAnnounced({key,text:summary.text});},250);
    return()=>clearTimeout(timer);
  },[key,summary.text]);
  if(!position)return null;
  return <section className="context-tools" aria-label="Code position" aria-describedby={descriptionId} tabIndex={0}>
    <span id={descriptionId}>{codePositionText(position)}</span>
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announced.key===key?announced.text:''}</span>
  </section>;
}
