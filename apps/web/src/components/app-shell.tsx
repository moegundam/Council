"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, CircleHelp, Code2, ListChecks, MessagesSquare, PanelsTopLeft, Settings2, Target } from "lucide-react";
import type { ReactNode } from "react";
import { goalRunAutonomyUiEnabled } from "../lib/feature-flags";

const navItems = [
  ...(goalRunAutonomyUiEnabled ? [{ href: "/goals", label: "目標", icon: Target }] : []),
  { href: "/", label: "討論", icon: MessagesSquare },
  { href: "/tasks", label: "任務", icon: ListChecks },
  { href: "/agents", label: "Agent", icon: Bot },
  { href: "/settings", label: "設定", icon: Settings2 }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Council 首頁">
          <span className="brand-mark"><PanelsTopLeft size={17} /></span>
          <span>Council</span>
        </Link>
        <nav className="primary-nav" aria-label="主要導覽">
          {navItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return <Link key={item.href} href={item.href} className={active ? "active" : ""} aria-label={item.label}><Icon size={15} /><span>{item.label}</span></Link>;
          })}
        </nav>
        <Link href="/docs" className={`documentation-link ${pathname.startsWith("/docs") ? "active" : ""}`} aria-label="文件中心" aria-current={pathname.startsWith("/docs") ? "page" : undefined} title="文件中心">
          <CircleHelp size={16} aria-hidden="true" /><span>文件</span>
        </Link>
        <Link href="/source" className={`source-link ${pathname.startsWith("/source") ? "active" : ""}`} aria-label="此版本原始碼" aria-current={pathname.startsWith("/source") ? "page" : undefined} title="此版本原始碼">
          <Code2 size={16} aria-hidden="true" /><span>原始碼</span>
        </Link>
        <div className="owner-avatar" title="擁有者">OW</div>
      </header>
      {children}
    </div>
  );
}
