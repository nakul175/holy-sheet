// @vitest-environment jsdom
import { describe,expect,it,vi } from 'vitest';
import { inspectedTextLink,openInspectedLink } from '../components/editor/link-inspector';

describe('document hyperlink inspector helpers',()=>{
  it('resolves only text anchors and preserves their literal destination',()=>{
    document.body.innerHTML='<div class="rich-prose"><p><a href="https://example.test/😀?x=%3Ctag%3E"><strong>HTML-like</strong></a></p><div data-hs-reference><a href="/pages/page-a">Page</a></div><div class="reference-block"><a href="/pages/page-b">Existing page block</a></div><div class="file-block"><a href="/api/media/file-a" download>File</a></div><nav class="contents-block"><a href="#heading-a">Heading</a></nav></div>';
    const text=document.querySelector('strong')!,reference=document.querySelector('[data-hs-reference] a')!,existingReference=document.querySelector('.reference-block a')!,file=document.querySelector('.file-block a')!,contents=document.querySelector('.contents-block a')!;
    expect(inspectedTextLink(text)?.href).toBe('https://example.test/😀?x=%3Ctag%3E');
    expect(inspectedTextLink(reference)).toBeNull();expect(inspectedTextLink(existingReference)).toBeNull();expect(inspectedTextLink(file)).toBeNull();expect(inspectedTextLink(contents)).toBeNull();expect(inspectedTextLink(document.body)).toBeNull();
  });

  it('revalidates every open and isolates browsing contexts without fetching',()=>{
    const open=vi.fn(()=>({opener:{} } as Window));
    expect(openInspectedLink('https://example.test/path',open)).toBe(true);expect(open).toHaveBeenCalledWith('https://example.test/path','_blank','noopener,noreferrer');expect(open.mock.results[0].value.opener).toBeNull();
    expect(openInspectedLink('/pages/page-a#heading-a',open)).toBe(true);expect(open).toHaveBeenLastCalledWith('/pages/page-a#heading-a','_blank','noopener,noreferrer');
    expect(openInspectedLink('mailto:reader@example.test',open)).toBe(true);expect(open).toHaveBeenLastCalledWith('mailto:reader@example.test','_self',undefined);
    expect(openInspectedLink('tel:+44123456789',open)).toBe(true);expect(open).toHaveBeenLastCalledWith('tel:+44123456789','_self',undefined);
    for(const unsafe of ['javascript:alert(1)','data:text/html,bad','//example.test','https://example.test/ bad'])expect(openInspectedLink(unsafe,open)).toBe(false);
  });
});
