"use client";
import { useEffect, useState } from "react";
import { requestJson } from "./editor/use-document-session";
import type { PageTreeSlice } from "../lib/page-tree-model";
import UiIcon from "./ui-icon";

export default function InPageSubpages({ workspaceId, spaceId, pageId, canCreate, onOpen, onCreate }: { workspaceId: string; spaceId: string; pageId: string; canCreate: boolean; onOpen: (id: string) => void; onCreate: () => void }) {
  const [slice, setSlice] = useState<PageTreeSlice | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => requestJson<PageTreeSlice>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/page-tree?spaceId=${encodeURIComponent(spaceId)}&parentId=${encodeURIComponent(pageId)}`).then(result => {
      if (live) { setSlice(result); setFailed(false); }
    }).catch(() => { if (live) setFailed(true); });
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { live = false; window.removeEventListener("focus", onFocus); };
  }, [workspaceId, spaceId, pageId]);

  if (failed || (!canCreate && !slice?.nodes.length)) return null;
  return <section className="in-page-subpages" aria-labelledby="in-page-subpages-heading">
    <div className="in-page-subpages-heading">
      <div><span className="in-page-subpages-kicker">CONTINUE READING</span><h2 id="in-page-subpages-heading">Subpages</h2></div>
      {canCreate && <button type="button" onClick={onCreate}><UiIcon name="plus"/>Add subpage</button>}
    </div>
    {slice?.nodes.length ? <ul>{slice.nodes.map(child => <li key={child.id}>
      <button type="button" onClick={() => onOpen(child.id)} aria-label={`Open subpage ${child.title}`}>
        <span className="in-page-subpage-icon"><UiIcon name="document"/></span><span><strong>{child.title}</strong><small>Subpage</small></span><span className="in-page-subpage-arrow" aria-hidden="true">→</span>
      </button>
    </li>)}</ul> : <p className="in-page-subpages-empty">Break out a substantial section when it deserves its own page.</p>}
  </section>;
}
