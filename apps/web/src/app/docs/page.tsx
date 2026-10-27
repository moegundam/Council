import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { DocumentationCenter } from "../../components/documentation-center";

export const metadata: Metadata = {
  title: "文件中心 | Council",
  description: "Council 功能使用說明與操作指南"
};

export default function DocumentationPage() {
  return <AppShell><DocumentationCenter /></AppShell>;
}
