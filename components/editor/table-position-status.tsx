'use client';
import { useEffect,useRef,useState } from 'react';

export function TablePositionStatus({description,contextKey}:{description:string;contextKey:string}){
  const [announcement,setAnnouncement]=useState(''),previous=useRef('');
  useEffect(()=>{previous.current='';setAnnouncement('');},[contextKey]);
  useEffect(()=>{if(description===previous.current)return;previous.current=description;setAnnouncement(description);},[description]);
  if(!description)return null;
  return <section className="table-position-status" aria-label="Table position" tabIndex={0}>
    <span aria-hidden="true">{description}</span>
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </section>;
}
