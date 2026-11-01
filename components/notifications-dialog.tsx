'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { requestJson } from './editor/use-document-session';
import { CommentText } from './discussion-panel';
type Notification={id:string;pageId:string;pageTitle:string;threadId:string;body:string|null;authorName:string;createdAt:string;readAt:string|null;kind?:string};
export default function NotificationsDialog({onClose,onOpen}:{onClose:()=>void;onOpen:(pageId:string,threadId?:string)=>void}){
  const [items,setItems]=useState<Notification[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const generation=useRef(0);
  const load=useCallback(async()=>{const request=++generation.current;try{const data=await requestJson<{notifications:Notification[]}>('/api/v1/notifications');if(request!==generation.current)return;setItems(data.notifications);setError('');}catch(e){if(request!==generation.current)return;setItems([]);setError(e instanceof Error?e.message:'Notifications unavailable');}finally{if(request===generation.current)setLoading(false);}},[]);
  useEffect(()=>{const refresh=()=>{if(document.visibilityState==='visible')void load();};void load();const timer=window.setInterval(refresh,4000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);return()=>{generation.current++;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};},[load]);
  async function open(n:Notification){try{await requestJson('/api/v1/notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:n.id})});if(n.kind&&n.kind!=='discussion')onOpen(n.pageId);else onOpen(n.pageId,n.threadId);}catch(e){setError(e instanceof Error?e.message:'Notification unavailable');void load();}}
  return <Dialog title="Notifications" onClose={onClose}>{loading?<p role="status">Loading current notifications…</p>:error?<p role="alert">{error}</p>:items.length?<ul className="notification-list">{items.map(n=><li key={n.id}><button className="notification-link" onClick={()=>void open(n)}><strong>{!n.readAt&&<span aria-label="Unread">● </span>}{n.pageTitle}</strong><small>{n.authorName} · {new Date(n.createdAt).toLocaleString()}</small></button>{n.body?<CommentText body={n.body.slice(0,240)}/>:<p>{n.kind&&n.kind!=='discussion'?'Page is restricted or unavailable':'Comment deleted'}</p>}</li>)}</ul>:<p>No accessible notifications yet.</p>}</Dialog>;
}
