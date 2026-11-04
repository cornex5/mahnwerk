import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { SiteFooter } from "@/components/SiteChrome";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://mahnwerk.vercel.app"),
  title: "Mahnwerk: German-law dunning on PayPal Invoicing",
  description:
    "Mahnwerk is a dunning engine for German freelancers and small firms. Code decides default, interest and fees (BGB 286, 288). Claude drafts the wording. You approve each step. PayPal sandbox only.",
  openGraph: {
    type: "website",
    siteName: "Mahnwerk",
    title: "Mahnwerk: German-law dunning on PayPal Invoicing",
    description: "Code decides the money, Claude drafts the letters, you approve. Runs on the PayPal sandbox.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Mahnwerk landing page with a worked claim calculation" }],
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-fg">
          Skip to content
        </a>
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
