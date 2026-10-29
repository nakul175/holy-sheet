// @vitest-environment jsdom
import { act,createElement } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { LinkInspector } from '../components/editor/link-inspector';

let host:HTMLDivElement,root:Root,anchor:HTMLAnchorElement;
const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!;

beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  anchor=document.createElement('a');anchor.href='https://example.test/😀?long='+('x'.repeat(500));anchor.textContent='<Inspect>';document.body.append(anchor);anchor.focus();
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();anchor.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('link inspector component',()=>{
  it('copies exactly, reports denial honestly and restores focus on dismissal',async()=>{
    const writeText=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied')),onClose=vi.fn();
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
    await act(async()=>root.render(createElement(LinkInspector,{link:{anchor,href:anchor.getAttribute('href')!},onClose})));
    const destination=host.querySelector<HTMLInputElement>('input[readonly]')!;expect(destination.value).toContain('😀');
    await act(async()=>button('Copy').click());expect(writeText).toHaveBeenCalledWith(anchor.getAttribute('href'));expect(host.textContent).toContain('Destination copied.');
    await act(async()=>button('Copy').click());expect(host.querySelector('[role=alert]')?.textContent).toContain('Clipboard unavailable');expect(document.activeElement).toBe(destination);expect(destination.selectionStart).toBe(0);expect(destination.selectionEnd).toBe(destination.value.length);
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click());expect(onClose).toHaveBeenCalledOnce();
    await act(async()=>root.unmount());expect(document.activeElement).toBe(anchor);root=createRoot(host);
  });

  it('dismisses when the link is removed or its destination changes',async()=>{
    const onClose=vi.fn();await act(async()=>root.render(createElement(LinkInspector,{link:{anchor,href:anchor.getAttribute('href')!},onClose})));
    await act(async()=>anchor.setAttribute('href','javascript:alert(1)'));await act(async()=>Promise.resolve());expect(onClose).toHaveBeenCalledOnce();
  });
});
