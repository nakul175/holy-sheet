import HolySheetApp from "../../../../components/holy-sheet-app";
export default async function EmbeddedDocument({params}:{params:Promise<{id:string}>}){return <HolySheetApp key={(await params).id} initialPageId={(await params).id} embedded/>;}
