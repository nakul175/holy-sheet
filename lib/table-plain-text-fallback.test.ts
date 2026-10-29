// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {TablePlainTextFallback} from '../components/editor/table-plain-text-fallback';

let cleanup=async()=>{};afterEach(async()=>{await cleanup();cleanup=async()=>{};vi.restoreAllMocks();});
it('shows selectable exact text, retries, closes and restores focus',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const launcher=document.createElement('button');launcher.textContent='Copy as plain text';document.body.append(launcher);launcher.focus();
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),retry=vi.fn(),close=vi.fn();cleanup=async()=>{await act(async()=>root.unmount());host.remove();launcher.remove();};
  await act(async()=>root.render(createElement(TablePlainTextFallback,{text:'A\tB\nC\\nD',onRetry:retry,onClose:close})));
  const area=host.querySelector('textarea')!;expect(area.value).toBe('A\tB\nC\\nD');expect(area.readOnly).toBe(true);expect(document.activeElement).toBe(host.querySelector('[aria-label="Close dialog"]'));expect(host.querySelector('[role=alert]')?.textContent).toContain('unavailable');
  await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Retry copy')!.click());expect(retry).toHaveBeenCalledOnce();
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click());expect(close).toHaveBeenCalledOnce();
});
