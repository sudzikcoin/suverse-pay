import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
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
      </body>
    </html>
  );
}
