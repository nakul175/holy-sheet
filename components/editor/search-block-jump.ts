import { SEARCH_BLOCK_HIGHLIGHT_MS, parseBlockFragment } from "../../lib/search-jump-model";
import { openSectionsForNavigation, type TemporarySection } from "./section-navigation";

export function revealSearchBlock(root: HTMLElement, blockId: string, preferenceKey: string, highlightMs = SEARCH_BLOCK_HIGHLIGHT_MS) {
  const matches = Array.from(root.querySelectorAll<HTMLElement>("[data-id]")).filter(node => node.dataset.id === blockId && node.closest(".rich-prose") === root);
  if (matches.length !== 1) return false;
  const target = matches[0];
  const temporary: TemporarySection[] = [];
  openSectionsForNavigation(target, preferenceKey, temporary, root);
  target.classList.add("hs-block-highlight");
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  window.setTimeout(() => target.classList.remove("hs-block-highlight"), highlightMs);
  return true;
}

/** Follows `#block-{id}` on the open page and expands collapsed sections around that block. */
export function watchSearchBlockJump({ host, scope, pageId }: { host: HTMLElement; scope: string; pageId: string }) {
  let alive = true;
  let revealed = "";
  const read = () => {
    if (!alive || location.pathname !== `/pages/${encodeURIComponent(pageId)}`) return;
    const token = location.pathname + location.hash;
    if (revealed === token) return;
    const id = parseBlockFragment(location.hash);
    if (!id) return;
    const root = host.querySelector<HTMLElement>(".rich-prose");
    if (!root || !revealSearchBlock(root, id, scope)) return;
    revealed = token;
    observer.disconnect();
  };
  const observer = new MutationObserver(read);
  observer.observe(host, { childList: true, subtree: true });
  window.addEventListener("hashchange", read);
  const timer = window.setTimeout(() => observer.disconnect(), 5000);
  read();
  return () => { alive = false; window.clearTimeout(timer); observer.disconnect(); window.removeEventListener("hashchange", read); };
}
