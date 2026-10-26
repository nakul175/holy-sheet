'use client';
import { useCallback,useEffect,useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { requestJson } from './editor/use-document-session';
import { CommentText } from './discussion-panel';
type Notification={id:string;pageId:string;pageTitle:string;threadId:string;body:string|null;authorName:string;createdAt:string;readAt:string|null};
export default function NotificationsDialog({onClose,onOpen}:{onClose:()=>void;onOpen:(pageId:string,threadId:string)=>void}){
  const [items,setItems]=useState<Notification[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const load=useCallback(async()=>{try{setItems((await requestJson<{notifications:Notification[]}>('/api/v1/notifications')).notifications);setError('');}catch(e){setItems([]);setError(e instanceof Error?e.message:'Notifications unavailable');}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();window.addEventListener('focus',load);return()=>window.removeEventListener('focus',load);},[load]);
  async function open(n:Notification){try{await requestJson('/api/v1/notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:n.id})});onOpen(n.pageId,n.threadId);}catch{setError('This notification is no longer available. Access may have changed.');void load();}}
  return <Dialog title="Notifications" onClose={onClose}>{loading?<p role="status">Loading current notifications…</p>:error?<p role="alert">{error}</p>:items.length?<ul className="notification-list">{items.map(n=><li key={n.id}><button className="notification-link" onClick={()=>void open(n)}><strong>{!n.readAt&&<span aria-label="Unread">● </span>}{n.pageTitle}</strong><small>{n.authorName} · {new Date(n.createdAt).toLocaleString()}</small></button>{n.body?<CommentText body={n.body.slice(0,240)}/>:<p>Comment deleted</p>}</li>)}</ul>:<p>No accessible notifications yet.</p>}</Dialog>;
}
