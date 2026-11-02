import DocumentSurface from "../../../components/document-surface";

export default async function PageScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentSurface key={id} pageId={id} />;
}
