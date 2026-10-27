import DOMPurify from "dompurify";
import { highlights,palette,safeUrl } from "./document";
import { rgbToHex } from "./editor-document";
export function sanitizePaste(html:string):string {
  const clean=DOMPurify.sanitize(html,{FORBID_TAGS:["script","style","iframe","object","embed","svg","math","form","input","button","textarea","link","meta","template"],FORBID_ATTR:["srcset","src","id"],ALLOW_DATA_ATTR:false});
  const doc=new DOMParser().parseFromString(clean,"text/html");
  doc.querySelectorAll("[hidden],[aria-hidden='true']").forEach(e=>e.remove());
  doc.querySelectorAll<HTMLElement>('[style]').forEach(e=>{if(e.style.display==='none'||e.style.visibility==='hidden'||(e.style.opacity!==''&&Number(e.style.opacity)===0)||['0','0px'].includes(e.style.fontSize))e.remove();});
  doc.querySelectorAll("a").forEach(a=>{if(!safeUrl(a.getAttribute("href")??""))a.removeAttribute("href");else{a.setAttribute("target","_blank");a.setAttribute("rel","noopener noreferrer");}});
  doc.querySelectorAll("img").forEach(img=>{img.replaceWith(doc.createTextNode(`[Image requires upload${img.alt?`: ${img.alt}`:""}]`));});
  doc.querySelectorAll<HTMLElement>("[style]").forEach(e=>{const color=rgbToHex(e.style.color),bg=rgbToHex(e.style.backgroundColor),bold=e.style.fontWeight,italic=e.style.fontStyle,decoration=e.style.textDecoration;e.removeAttribute("style");if(palette.includes(color))e.style.color=color;if(highlights.includes(bg))e.style.backgroundColor=bg;if(["bold","700","600"].includes(bold))e.style.fontWeight="bold";if(italic==="italic")e.style.fontStyle="italic";if(/^(underline|line-through)$/.test(decoration))e.style.textDecoration=decoration;});
  return doc.body.innerHTML;
}
