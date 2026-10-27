import type { Metadata } from "next";
import "./globals.css";
import SessionBoundary from '../components/session-boundary';

export const metadata: Metadata = {
  title: "Holy Sheet",
  description: "Pages that stay close to the work",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><SessionBoundary>{children}</SessionBoundary></body></html>;
}
