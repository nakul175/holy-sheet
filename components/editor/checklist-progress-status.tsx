'use client';
import {useEffect,useState} from 'react';
import {checklistProgressText,type ChecklistProgress} from './checklist-progress';
import styles from './checklist-progress-status.module.css';

/** Remounted by the editor's page/actor/access key; never dispatches or moves focus. */
export function ChecklistProgressStatus({value}:{value:ChecklistProgress|null}){
 const description=checklistProgressText(value),[announcement,setAnnouncement]=useState('');
 // Equal counts do not update the live region during caret moves or text-only edits.
 useEffect(()=>{setAnnouncement(description);},[description]);
 if(!description)return null;
 return <section className={styles.status} tabIndex={0} aria-label={`Checklist progress: ${description}`}>
  <span aria-hidden="true">{description}</span>
  <span className={styles.announcement} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
 </section>;
}
