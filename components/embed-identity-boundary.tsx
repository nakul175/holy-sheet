'use client';
import {useMemo,type ReactNode} from 'react';
import {SessionGate,createHolySheetSessionProvider} from '@aplyd/holy-sheet-editor/boundary';
/** Compatibility adapter; authorization/render gating belongs to the shared package. */
export default function EmbedIdentityBoundary({pageId,children}:{pageId:string;children:ReactNode}){
  const provider=useMemo(()=>createHolySheetSessionProvider(),[pageId]);
  return <SessionGate key={pageId} pageId={pageId} viewContext="embedded" sessionProvider={provider}>{children}</SessionGate>;
}
