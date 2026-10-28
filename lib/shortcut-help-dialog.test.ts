// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import ShortcutHelpDialog from '../components/shortcut-help-dialog';

let root:Root,host:HTMLDivElement,launcher:HTMLButtonElement;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);launcher=document.createElement('button');launcher.textContent='Keyboard shortcuts';document.body.append(launcher);launcher.focus();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();launcher.remove();vi.unstubAllGlobals();});

it('is searchable, labelled and marks editing actions unavailable for viewers',async()=>{await act(async()=>root.render(createElement(ShortcutHelpDialog,{editable:false,onClose:vi.fn()})));expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Keyboard shortcuts');expect(host.textContent).toContain('View-only page.');expect(host.textContent).toContain('Editing only · unavailable in view-only mode');expect(document.activeElement).toBe(host.querySelector('[aria-label="Close dialog"]'));const search=host.querySelector<HTMLInputElement>('input[type=search]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'heading');search.dispatchEvent(new Event('input',{bubbles:true}));});expect(host.textContent).toContain('Heading 1');expect(host.textContent).not.toContain('Find in this page');expect(host.querySelector('[aria-label="Ctrl plus Alt plus 1"]')).toBeTruthy();});

it('shows a concise empty state and leaves IME Escape to the search field',async()=>{const close=vi.fn();await act(async()=>root.render(createElement(ShortcutHelpDialog,{editable:true,onClose:close})));const search=host.querySelector<HTMLInputElement>('input[type=search]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'zzz');search.dispatchEvent(new Event('input',{bubbles:true}));});expect(host.textContent).toContain('No shortcuts match that filter.');await act(async()=>search.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true})));expect(close).not.toHaveBeenCalled();});
