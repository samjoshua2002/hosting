import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ScreenGuard } from "@/components/screen-guard";
import { HUE_BOOT } from "@/components/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Hosting Control",
  description: "Manage, monitor and deploy to a fleet of VMs.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: HUE_BOOT }} />
      </head>
      <body className="min-h-full min-w-[1024px] lg:min-w-0">
        {children}
        <ScreenGuard />
      </body>
    </html>
  );
}
