import type { Metadata } from "next";
import localFont from "next/font/local";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const figtree = localFont({
  src: "./fonts/Figtree.ttf",
  variable: "--font-figtree",
  weight: "300 900",
  display: "swap",
});

const jetbrains = localFont({
  src: "./fonts/JetBrainsMono.ttf",
  variable: "--font-jetbrains",
  weight: "100 800",
  display: "swap",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "WHARF — Hosting Control Plane",
  description:
    "Self-hosted control plane for websites, servers and Supabase database fleets.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${figtree.variable} ${jetbrains.variable} antialiased`}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
