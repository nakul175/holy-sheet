import { oidcRoute } from '../../../lib/oidc-bridge';
export const GET=(request:Request)=>oidcRoute('signIn',request);
