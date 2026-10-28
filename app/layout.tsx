import type { Metadata } from "next";
import localFont from "next/font/local";
import "@aplyd/holy-sheet-editor/styles.css";
import "./workspace.css";
import SessionBoundary from '../components/session-boundary';

const publicSans = localFont({src:[
  {path:'./fonts/PublicSans-Regular.woff2',weight:'400',style:'normal'},
  {path:'./fonts/PublicSans-Medium.woff2',weight:'500',style:'normal'},
  {path:'./fonts/PublicSans-SemiBold.woff2',weight:'600',style:'normal'},
],variable:'--font-public-sans',display:'swap',adjustFontFallback:'Arial'});

export const metadata: Metadata = {
  title: "Holy Sheet",
  description: "Pages that stay close to the work",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={publicSans.variable}><body><SessionBoundary>{children}</SessionBoundary></body></html>;
}
