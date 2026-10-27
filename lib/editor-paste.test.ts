// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeRichDocument, sanitizePaste } from "../components/editor/rich-editor";
describe('clipboard import safety',()=>{
  it('removes executable markup, event handlers, unsafe links and remote images while retaining readable text',()=>{const result=sanitizePaste('<p onclick="alert(1)">Keep <b>bold</b><script>alert(1)</script><a href="javascript:alert(2)">words</a><img src="https://tracker.example/pixel" alt="Chart"></p>');expect(result).not.toMatch(/onclick|<script|javascript:|https:\/\/tracker/);expect(result).toContain('Keep');expect(result).toContain('<b>bold</b>');expect(result).toContain('Image requires upload: Chart');});
  it('does not preserve hidden tracking text',()=>{for(const attributes of ['hidden','aria-hidden="true"','style="display:none"','style="visibility:hidden"','style="opacity:0"','style="font-size:0px"']){const result=sanitizePaste(`<p>Visible</p><span ${attributes}>Secret tracker</span>`);expect(result).not.toContain('Secret tracker');expect(result).toContain('Visible');}});
  it('normalizes RGB styles to the approved palette and removes unsupported styles without losing text',()=>{const doc=normalizeRichDocument({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Kept',marks:[{type:'textStyle',attrs:{color:'rgb(29, 78, 216)'}}]}]}]});expect(doc.content![0].content![0].marks![0].attrs?.color).toBe('#1d4ed8');expect(doc.content![0].attrs?.id).toBeTruthy();});
});
