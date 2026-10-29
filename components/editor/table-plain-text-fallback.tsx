'use client';
import { Dialog } from './dialog';

export function TablePlainTextFallback({text,onRetry,onClose}:{text:string;onRetry:()=>void;onClose:()=>void}){
  return <Dialog title="Copy table as plain text" onClose={onClose}>
    <p role="alert">Clipboard access is unavailable. Select and copy this exact plain-text table, or retry clipboard access.</p>
    <label>Plain-text table<textarea autoFocus readOnly rows={10} value={text} onFocus={event=>event.currentTarget.select()}/></label>
    <p><small>Tabs separate columns. Cell tabs, line breaks and backslashes use <code>\t</code>, <code>\n</code> and <code>\\</code>.</small></p>
    <div className="actions"><button onClick={onClose}>Close</button><button className="primary" onClick={onRetry}>Retry copy</button></div>
  </Dialog>;
}
