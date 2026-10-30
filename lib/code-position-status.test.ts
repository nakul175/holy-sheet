// @vitest-environment jsdom
import { act,createElement } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { CodePositionStatus } from '../components/editor/code-position-status';
import type { CodePosition } from '../components/editor/code-position';

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let container:HTMLDivElement,root:Root;
const value=(character=1,line=1):CodePosition=>({blockKey:'code',lines:3,range:false,from:{line,character,lineLength:5},to:{line,character,lineLength:5}});
beforeEach(()=>{vi.useFakeTimers();container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();});
async function render(position:CodePosition|null=value(),contextKey='actor:page:editor'){await act(async()=>root.render(createElement(CodePositionStatus,{position,contextKey})));}
async function idle(){await act(async()=>vi.advanceTimersByTime(250));}

it('exposes accurate focusable details without stealing focus and announces line context only after idle',async()=>{
  const input=document.createElement('input');document.body.append(input);input.focus();await render();expect(document.activeElement).toBe(input);
  const status=container.querySelector('section')!;expect(status.tabIndex).toBe(0);expect(document.getElementById(status.getAttribute('aria-describedby')!)?.textContent).toContain('character position 1');
  expect(container.querySelector('[role=status]')!.textContent).toBe('');await idle();expect(container.querySelector('[role=status]')!.textContent).toBe('Code block, line 1 of 3.');
  for(let i=2;i<=5;i++)await render(value(i));await idle();expect(container.querySelector('[role=status]')!.textContent).toBe('Code block, line 1 of 3.');expect(document.activeElement).toBe(input);
  input.remove();
});
it('coalesces rapid line navigation and clears stale announcements immediately on context change',async()=>{
  await render();await idle();await render(value(1,2));await act(async()=>vi.advanceTimersByTime(100));await render(value(1,3));expect(container.querySelector('[role=status]')!.textContent).toBe('');await idle();expect(container.querySelector('[role=status]')!.textContent).toBe('Code block, line 3 of 3.');
  await render(value(),'other:page:viewer');expect(container.querySelector('[role=status]')!.textContent).toBe('');await idle();expect(container.querySelector('[role=status]')!.textContent).toBe('Code block, line 1 of 3.');
});
it('removes status and cancels delayed work outside code or after unmount',async()=>{
  await render();await render(null);await idle();expect(container.textContent).toBe('');await render();await act(async()=>root.render(null));await idle();expect(container.textContent).toBe('');
});
