import type { ReactNode } from 'react';
export type ViewContext = 'standalone' | 'embedded';
export type SessionResult = {status:'ready';subject:string}|{status:'missing'|'signin'|'mismatch'|'unavailable'};
/** Implementations consult a trusted server. This result never grants API permissions. */
export interface SessionProvider {
  check(input:{pageId:string;viewContext:ViewContext;signal:AbortSignal}):Promise<SessionResult>;
}
export interface LocalEditorProps {pageId:string;viewContext:ViewContext;sessionProvider:SessionProvider}
export interface SessionGateProps extends LocalEditorProps {children:ReactNode}
export type HostSession = {status:'ready';subject:string;origin:string}|{status:'signin'|'unavailable'};
/** Host identity restricts the HS session inside the frame; it is not an HS credential. */
export interface HostSessionProvider {
  check(input:{pageId:string;signal:AbortSignal}):Promise<HostSession>;
}
export interface HostedEditorProps {pageId:string;viewContext:'embedded';sessionProvider:HostSessionProvider}
