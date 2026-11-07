import {expect,it} from 'vitest';
import {applicationDisplayName} from './application-display-name';
it('presents legacy Pages source identifiers without changing other app or user labels',()=>{
 for(const id of ['holy-sheet','holy-sheet-import','holy-sheet-template','holy-sheet-intake'])expect(applicationDisplayName(id)).toBe('Pages by Aplyd');
 for(const id of ['sho','user-defined-source','holy-sheet-custom'])expect(applicationDisplayName(id)).toBe(id);
});
