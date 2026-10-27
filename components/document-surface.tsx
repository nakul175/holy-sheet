'use client';
import {useMemo} from 'react';
import {HolySheetEditor,createHolySheetSessionProvider} from '@aplyd/holy-sheet-editor/local';
export default function DocumentSurface({pageId,embedded=false}:{pageId:string;embedded?:boolean}){
  const provider=useMemo(()=>createHolySheetSessionProvider(),[pageId]);
  return <HolySheetEditor key={pageId} pageId={pageId} viewContext={embedded?'embedded':'standalone'} sessionProvider={provider}/>;
}
