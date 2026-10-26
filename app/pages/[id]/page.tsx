import HolySheetApp from "../../../components/holy-sheet-app";

export default async function PageScreen({ params }: { params: Promise<{ id: string }> }) {
  return <HolySheetApp initialPageId={(await params).id} />;
}
