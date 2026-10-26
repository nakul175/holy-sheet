import HolySheetApp from "../../../components/holy-sheet-app";

export default async function PageScreen({ params }: { params: Promise<{ id: string }> }) {
  return <HolySheetApp key={(await params).id} initialPageId={(await params).id} />;
}
