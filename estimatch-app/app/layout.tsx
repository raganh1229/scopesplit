import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScopeSplit — Xactimate Estimate Comparison Tool",
  description: "Upload two Xactimate PDFs and get a detailed, line-by-line comparison in minutes.",
  icons: {
    icon: '/icon_logo_white.png',
    shortcut: '/icon_logo_white.png',
    apple: '/icon_logo_white.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
