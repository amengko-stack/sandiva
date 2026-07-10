import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sandiva Timesheets",
  description: "Record billable time, submit for approval, and generate matter invoices.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#003D5A",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="brandbar fixed inset-x-0 top-0 z-50" />
        {children}
      </body>
    </html>
  );
}
