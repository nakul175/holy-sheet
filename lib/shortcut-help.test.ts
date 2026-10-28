import {describe,expect,it} from 'vitest';
import {filterShortcuts,shortcutKeyLabel,shortcutKeys,shortcutPlatform,shortcuts} from './shortcut-help';

describe('keyboard shortcut reference',()=>{
 it('maps macOS and Windows/Linux labels without changing the catalogue',()=>{const find=shortcuts.find(item=>item.id==='find-page')!;expect(shortcutKeys(find,'mac')).toEqual(['⌘','F']);expect(shortcutKeys(find,'other')).toEqual(['Ctrl','F']);expect(shortcutKeyLabel(['⌘','⌥','2'])).toBe('Command plus Option plus 2');expect(shortcutKeyLabel(['Ctrl','\\'])).toBe('Ctrl plus Backslash');});
 it('detects Apple devices conservatively',()=>{expect(shortcutPlatform('MacIntel','')).toBe('mac');expect(shortcutPlatform('','Mozilla/5.0 (iPad)')).toBe('mac');expect(shortcutPlatform('Win32','Mozilla/5.0 (Windows NT 10.0)')).toBe('other');expect(shortcutPlatform('Linux x86_64','')).toBe('other');});
 it('filters action, group, description and either platform labels',()=>{expect(filterShortcuts('heading').map(item=>item.id)).toEqual(['heading-1','heading-2','heading-3']);expect(filterShortcuts('Ctrl').length).toBe(shortcuts.length);expect(filterShortcuts('literal').map(item=>item.id)).toEqual(['plain-paste']);expect(filterShortcuts('not a shortcut')).toEqual([]);});
 it('keeps only find available to viewers',()=>{expect(shortcuts.filter(item=>!item.editable).map(item=>item.id)).toEqual(['find-page']);expect(shortcuts.filter(item=>item.editable).length).toBeGreaterThan(0);});
});
