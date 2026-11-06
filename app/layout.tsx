import type { Metadata } from "next";
import "@aplyd/holy-sheet-editor/styles.css";
import "./workspace.css";
import "./workspace-sections.css";
import SessionBoundary from '../components/session-boundary';

export const metadata: Metadata = {
  title: "Pages by Aplyd",
  description: "Pages that stay close to the work",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><head><link rel="stylesheet" href="/fonts/pages.css"/></head><body><SessionBoundary>{children}</SessionBoundary></body></html>;
}
