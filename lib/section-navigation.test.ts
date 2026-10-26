// @vitest-environment jsdom
import { afterEach,describe,expect,it } from 'vitest';
import { markSectionInteraction,openSectionsForNavigation,restoreTemporarySections,type TemporarySection } from '../components/editor/section-navigation';
afterEach(()=>{document.body.innerHTML='';localStorage.clear();});
function fixture(){document.body.innerHTML='<div data-type="details" data-id="section"><button>Toggle</button><div><div data-type="detailsSummary">Title</div><div data-type="detailsContent" hidden><p id="target">Passage</p></div></div></div>';return {section:document.querySelector<HTMLElement>('[data-type=details]')!,target:document.querySelector('#target')!};}
describe('temporary section navigation',()=>{
  it('opens actual hidden content and accessible toggle state, then restores without changing personal preferences',()=>{const {section,target}=fixture(),entries:TemporarySection[]=[];localStorage.setItem('hs-collapse:user:section','closed');openSectionsForNavigation(target,'user',entries);expect(section.querySelector('[data-type=detailsContent]')!.hasAttribute('hidden')).toBe(false);expect(section.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');expect(localStorage.getItem('hs-collapse:user:section')).toBe('closed');expect(restoreTemporarySections(entries)).toEqual([]);expect(section.querySelector('[data-type=detailsContent]')!.hasAttribute('hidden')).toBe(true);});
  it('does not override a deliberate interaction or an updated personal preference',()=>{const {section,target}=fixture(),entries:TemporarySection[]=[];openSectionsForNavigation(target,'user',entries);markSectionInteraction(target);restoreTemporarySections(entries);expect(section.classList.contains('is-open')).toBe(true);});
});
