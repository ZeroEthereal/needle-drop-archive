import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", base).toString();

  return {
    metadataBase: base,
    title: {
      default: "拾针 · 网易云音乐防丢台",
      template: "%s · 拾针",
    },
    description: "每天守住你选择的网易云歌单，准确记录已消失与已变灰的音乐。",
    applicationName: "拾针",
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "拾针 · 网易云音乐防丢台",
      description: "收藏会消失，记忆不该。每天自动同步、复核并提醒。",
      locale: "zh_CN",
      type: "website",
      url: base,
      images: [{ url: socialImage, width: 1731, height: 909, alt: "拾针 · 网易云音乐防丢台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "拾针 · 网易云音乐防丢台",
      description: "收藏会消失，记忆不该。",
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#07050d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
