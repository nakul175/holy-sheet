// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import HolySheetApp from '../components/holy-sheet-app';
import {schemaVersion} from './document';

const mocks=vi.hoisted(()=>({change:vi.fn(),save:vi.fn(),checkpoint:vi.fn(),role:'editor'}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock('../components/editor/rich-editor',()=>({default:()=>createElement('div',{'aria-label':'Mock editor'}),Dialog:()=>null}));
vi.mock('../components/personal-navigation',()=>({default:()=>null}));
vi.mock('../components/discussion-panel',()=>({default:()=>null}));
vi.mock('../components/editor/pending-uploads',()=>({default:()=>null}));
vi.mock('../components/backlinks',()=>({default:()=>null}));
vi.mock('../components/templates-dialog',()=>({default:()=>null,TemplateSource:()=>null}));
vi.mock('../components/session-boundary',()=>({SignInLink:()=>null,SignOutButton:()=>null}));
vi.mock('../components/editor/use-document-session',()=>({requestJson:async()=>({pages:[],spaces:[]}),useDocumentSession:()=>({page:{id:'page',title:'Unsaved title',schemaVersion,role:mocks.role,version:7,workspaceId:'workspace',workspaceName:'QA',spaceName:'Product',visibility:'private',document:{type:'doc',content:[{type:'paragraph',attrs:{id:'p'},content:[{type:'text',text:'Unsaved draft'}]}]}},status:'unsaved',candidates:[],actorId:'actor',accessUnverified:false,checkpoint:mocks.checkpoint,save:mocks.save,change:mocks.change,dirty:()=>true})}));

let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);mocks.role='editor';mocks.change.mockClear();mocks.save.mockClear();mocks.checkpoint.mockClear();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('opens from the account menu without touching drafts and restores the exact launcher',async()=>{await act(async()=>root.render(createElement(HolySheetApp,{initialPageId:'page'})));const account=host.querySelector<HTMLDetailsElement>('.account-menu')!;account.open=true;const launcher=[...account.querySelectorAll('button')].find(button=>button.textContent==='Keyboard shortcuts')!;launcher.focus();await act(async()=>launcher.click());expect(account.open).toBe(false);expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Keyboard shortcuts');expect(host.textContent).not.toContain('View-only page.');expect(mocks.change).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();expect(mocks.checkpoint).not.toHaveBeenCalled();await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));expect(account.open).toBe(true);expect(document.activeElement).toBe(launcher);expect(mocks.change).not.toHaveBeenCalled();});

it('shows the same reference in viewer context while marking edits unavailable',async()=>{mocks.role='viewer';await act(async()=>root.render(createElement(HolySheetApp,{initialPageId:'page'})));const account=host.querySelector<HTMLDetailsElement>('.account-menu')!;account.open=true;await act(async()=>[...account.querySelectorAll('button')].find(button=>button.textContent==='Keyboard shortcuts')!.click());expect(host.textContent).toContain('View-only page.');expect(host.textContent).toContain('Find in this page');expect(host.textContent).toContain('Editing only · unavailable in view-only mode');expect(mocks.change).not.toHaveBeenCalled();});
