// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';

vi.mock('@tiptap/react',()=>({NodeViewWrapper:({as='div',children,...props}:{as?:string;children?:ReactNode;[key:string]:unknown})=>createElement(as,props,children)}));
import {permittedImageSource,ProtectedImageView} from '../components/editor/image-viewer';

const id='11111111-1111-4111-8111-111111111111';
const attrs={attachmentId:id,src:`/api/media/${id}`,alt:'Quarterly revenue chart',caption:'FY26 actuals',width:1000};
let root:Root,container:HTMLDivElement;

beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('protected image source',()=>{
 it('accepts only the exact protected gateway for the bound attachment',()=>{
  expect(permittedImageSource(attrs)).toBe(`/api/media/${id}`);
  for(const value of [
   {...attrs,src:`https://staging.holysheet.aplyd.org/api/media/${id}`},
   {...attrs,src:`/api/media/${id}?download=1`},
   {...attrs,src:`/api/media/${crypto.randomUUID()}`},
   {...attrs,attachmentId:'not-a-uuid'},
   {...attrs,src:'data:image/png;base64,AA=='},
   {...attrs,src:'//evil.invalid/image'},
  ])expect(permittedImageSource(value)).toBeNull();
 });
});

describe('accessible enlarged image viewer',()=>{
 async function render(attributes:Record<string,unknown>=attrs){await act(async()=>root.render(createElement(ProtectedImageView,{node:{attrs:attributes}} as never)));}
 function button(name:string){return [...document.querySelectorAll('button')].find(item=>item.textContent===name)!;}
 it('opens without mutating the node, exposes context, reports readiness and restores focus',async()=>{
  const node={attrs:{...attrs}},before=JSON.stringify(attrs);await act(async()=>root.render(createElement(ProtectedImageView,{node} as never)));
  const opener=button('Enlarge image');opener.focus();await act(async()=>opener.click());
  const dialog=document.querySelector<HTMLElement>('[role=dialog]')!,images=dialog.querySelectorAll('img');expect(dialog.getAttribute('aria-label')).toBe('Enlarged image');expect(dialog.textContent).toContain('Quarterly revenue chart');expect(dialog.textContent).toContain('FY26 actuals');expect(images).toHaveLength(1);expect(images[0].getAttribute('src')).toBe(`/api/media/${id}`);expect(dialog.querySelector('[role=status]')?.textContent).toContain('Loading');
  await act(async()=>images[0].dispatchEvent(new Event('load')));expect(images[0].className).toContain('is-ready');expect(JSON.stringify(node.attrs)).toBe(before);
  await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click());expect(document.querySelector('[role=dialog]')).toBeNull();expect(document.activeElement).toBe(opener);
 });
 it('fails closed for an invalid source and never creates a viewer image request',async()=>{await render({...attrs,src:'https://evil.invalid/private.png'});await act(async()=>button('Enlarge image').click());const dialog=document.querySelector('[role=dialog]')!;expect(dialog.textContent).toContain('unavailable');expect(dialog.querySelector('img')).toBeNull();expect(button('Retry image')).toBeUndefined();});
 it('shows an honest failure, retries only the same source, and closes on logout',async()=>{await render();await act(async()=>button('Enlarge image').click());let image=document.querySelector<HTMLImageElement>('[role=dialog] img')!;await act(async()=>image.dispatchEvent(new Event('error')));expect(document.querySelector('[role=alert]')?.textContent).toContain('unavailable');const source=image.src;await act(async()=>button('Retry image').click());image=document.querySelector<HTMLImageElement>('[role=dialog] img')!;expect(image.src).toBe(source);await act(async()=>window.dispatchEvent(new Event('holy-sheet:logout')));expect(document.querySelector('[role=dialog]')).toBeNull();});
});
