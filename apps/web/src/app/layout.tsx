import type { Metadata } from "next";
import "./globals.css";
import "@xyflow/react/dist/style.css";
import { PlatformProvider } from "./providers";

export const metadata: Metadata = {
  title: "Council",
  description: "AI Agent Meeting Platform"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body><PlatformProvider>{children}</PlatformProvider></body></html>;
}
