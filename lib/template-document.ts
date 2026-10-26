import { ensureIds,validateDocument,type RichNode } from './document';
import { richSchema } from './rich-schema';
// Prepare editor defaults before publication so opening a copied page does not fabricate a save.
// This is template preparation only; historical revision hashes keep their original representation.
export function prepareTemplateDocument(input:unknown){
  const document=richSchema().nodeFromJSON(validateDocument(input)).toJSON() as RichNode;
  function visit(n:RichNode):RichNode{const attrs={...n.attrs};if(['tableCell','tableHeader'].includes(n.type))delete attrs.align;if(n.type==='codeBlock'&&!attrs.language)attrs.language='plaintext';return {...n,...(n.attrs?{attrs}:{}),...(n.content?{content:n.content.map(visit)}:{})};}
  const result=visit(document);if(result.content?.at(-1)?.type!=='paragraph')result.content!.push({type:'paragraph',attrs:{id:`${String(result.content!.at(-1)!.attrs?.id).slice(0,90)}-tail`}});
  return validateDocument(ensureIds(result));
}
