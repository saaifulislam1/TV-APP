import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Public IPTV Explorer",
  description: "Browse public IPTV channels by country and category.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />
        <link rel="preconnect" href="https://iptv-org.github.io" />
        <link rel="dns-prefetch" href="https://iptv-org.github.io" />
        <link
          rel="preload"
          as="script"
          href="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
