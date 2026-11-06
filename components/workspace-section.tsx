import type { ReactNode } from 'react';
import HolySheetBrand from './holy-sheet-brand';
import UiIcon from './ui-icon';

export function WorkspaceSection({workspaceId, section, spaces = [], children}: {
  workspaceId: string; section: 'Spaces' | 'Snippets'; children: ReactNode; spaces?: { id:string; name:string }[];
}) {
  const base = '/workspaces/' + encodeURIComponent(workspaceId);
  return <div className="workspace-section">
    <header><a href="/" className="suite-brand"><HolySheetBrand onBlue/>Aplyd Pages</a><a href="/workspaces">Workspaces</a></header>
    <nav aria-label="Workspace navigation">
      <a href={base + '/spaces'} aria-current={section === 'Spaces' ? 'location' : undefined}><UiIcon name="folder"/>Spaces</a>
      <a href={base + '/snippets'} aria-current={section === 'Snippets' ? 'location' : undefined}><UiIcon name="document"/>Snippets</a>
      {spaces.length > 0 && <div className="workspace-space-links">{spaces.map(space => <a key={space.id} href={base + "/spaces/" + encodeURIComponent(space.id)}><UiIcon name="folder"/>{space.name}</a>)}</div>}
    </nav>
    {children}
  </div>;
}

export function SpaceTabs({workspaceId, spaceId, reviews=false}: {workspaceId:string; spaceId:string; reviews?:boolean}) {
  const path = '/workspaces/'+encodeURIComponent(workspaceId)+'/spaces/'+encodeURIComponent(spaceId);
  return <nav className="space-tabs" aria-label="Space navigation"><a aria-current={reviews ? undefined : 'page'} href={path}>Pages</a><a aria-current={reviews ? 'page' : undefined} href={path+'/reviews'}>Page reviews</a></nav>;
}
