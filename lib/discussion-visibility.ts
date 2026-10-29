import type {DocumentPage} from './repository';
import {blockTexts,type Anchor} from './comment-anchors';
import type {Sql} from './database';
import type {RichNode} from './document';
export type ThreadAnchorView={anchors:Anchor[];publication_anchors?:Anchor[]|null;anchor_publication_id?:string|null};
export function viewedPublicationId(page:DocumentPage){return page.publicationFingerprint?.split(':')[0];}
function matches(document:RichNode,anchors:Anchor[]){const visible=blockTexts(document);return anchors.every(a=>{const text=visible.get(a.blockId);return text!==undefined&&Number.isSafeInteger(a.start)&&Number.isSafeInteger(a.end)&&a.start>=0&&a.end>a.start&&text.slice(a.start,a.end)===a.quote;});}
/** Editorial draft anchors are not a grant to reveal their quotes or thread metadata. */
export function visibleThreadAnchors(page:DocumentPage,thread:ThreadAnchorView):Anchor[]|null{
 const publicationId=viewedPublicationId(page);
 if(!publicationId||!thread.anchors.length)return thread.anchors;
 if(thread.anchor_publication_id!==publicationId||!thread.publication_anchors)return null;
 return matches(page.document,thread.publication_anchors)?thread.publication_anchors:null;
}
export function threadVisible(page:DocumentPage,thread:ThreadAnchorView){return visibleThreadAnchors(page,thread)!==null;}
export async function bindThreadPublicationAnchors(tx:Sql,pageId:string,publicationId:string,threadId:string,document:RichNode,anchors:Anchor[]){
 if(anchors.length&&matches(document,anchors))await tx.query('INSERT INTO hs_publication_thread_anchors(page_id,publication_id,thread_id,anchors) VALUES($1,$2,$3,$4)',[pageId,publicationId,threadId,JSON.stringify(anchors)]);
}
export async function bindPublicationThreads(tx:Sql,pageId:string,publicationId:string,document:RichNode){
 const threads=await tx.query<{id:string;anchors:Anchor[]}>('SELECT id,anchors FROM hs_threads WHERE page_id=$1 ORDER BY id FOR UPDATE',[pageId]);
 for(const t of threads.rows)await bindThreadPublicationAnchors(tx,pageId,publicationId,t.id,document,t.anchors);
}
