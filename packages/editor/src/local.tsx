'use client';
import HolySheetApp from '../../../components/holy-sheet-app';
import {SessionGate} from './boundary';
import type {LocalEditorProps} from './contracts';
export {createHolySheetSessionProvider} from './boundary';
export type {LocalEditorProps,SessionProvider,ViewContext} from './contracts';
/** The actual HS editor, API client and recovery implementation, compiled from their canonical sources. */
export function HolySheetEditor(props:LocalEditorProps){
  return <SessionGate key={props.pageId} {...props}><HolySheetApp initialPageId={props.pageId} embedded={props.viewContext==='embedded'}/></SessionGate>;
}
