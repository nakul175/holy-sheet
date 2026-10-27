import HolySheetApp from "../../../../components/holy-sheet-app";
import EmbedIdentityBoundary from '../../../../components/embed-identity-boundary';
export default async function EmbeddedDocument({params}:{params:Promise<{id:string}>}){const {id}=await params;return <EmbedIdentityBoundary key={id} pageId={id}><HolySheetApp initialPageId={id} embedded/></EmbedIdentityBoundary>;}
