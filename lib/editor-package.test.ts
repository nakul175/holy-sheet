import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
it('ships the actual editor and recovery sources with verifiable client-only provenance',async()=>{
  const manifest=JSON.parse(await readFile('packages/editor/dist/source-manifest.json','utf8'));
  const paths=manifest.sources.map((s:{path:string})=>s.path);
  for(const source of ['components/holy-sheet-app.tsx','components/editor/rich-editor.tsx','components/editor/use-document-session.ts','lib/recovery-client.ts','packages/editor/src/local.tsx','packages/editor/src/hosted.tsx'])expect(paths).toContain(source);
  for(const source of ['lib/auth.ts','lib/database.ts','lib/storage.ts','lib/repository.ts','lib/oidc.ts'])expect(paths).not.toContain(source);
  for(const source of manifest.sources){expect(source.path).not.toMatch(/^(?:\/|\.\.)/);expect(createHash('sha256').update(await readFile(source.path)).digest('hex')).toBe(source.sha256);}
  const local=await readFile('packages/editor/dist/local.js','utf8');expect(local).toContain('HolySheetEditor');
  const types=await readFile('packages/editor/dist/contracts.d.ts','utf8');expect(types).toContain('sessionProvider:SessionProvider');expect(types).not.toMatch(/role\s*:/);
});
