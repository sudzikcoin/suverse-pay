import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import "./globals.css";

const inter = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

const jbm = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Suverse Pay — Dashboard",
  description:
    "Customer dashboard for the suverse-pay payment gateway. See settles, volume, success rate, and per-network breakdown across all supported chains.",
  manifest: "/manifest.json",
  applicationName: "Suverse Pay",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Suverse Pay",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/**
 * Mobile viewport — viewport-fit=cover so we can pad with
 * env(safe-area-inset-*) under the notch + home indicator (wired
 * in M5). themeColor matches the bg-background paint so iOS status
 * bar blends in once "Add to Home Screen" promotes us to standalone.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" className={`${inter.variable} ${jbm.variable} dark`}>
      <body className="min-h-screen bg-background font-sans text-foreground grain">
        <Providers>{children}</Providers>
        <MobileBottomNav />
      </body>
    </html>
  );
}
