import { oidcRoute } from '../../../lib/oidc-bridge';
export const POST=(request:Request)=>oidcRoute('signOut',request);
