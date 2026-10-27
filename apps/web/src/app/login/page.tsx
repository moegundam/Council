"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole, LogIn, PanelsTopLeft } from "lucide-react";
import { apiRequest } from "../../lib/api";
import { disposableTestLoginUiEnabled, tailnetQuickLoginUiEnabled } from "../../lib/feature-flags";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"password" | "tailnet" | "test" | null>(null);

  async function completeLogin(mode: "password" | "tailnet" | "test", path: string, body?: string) {
    setBusy(mode);
    setError("");
    try {
      await apiRequest(path, { method: "POST", ...(body === undefined ? {} : { body }) });
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登入失敗。");
    } finally {
      setBusy(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await completeLogin("password", "/api/auth/login", JSON.stringify({ email: data.get("email"), password: data.get("password") }));
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand"><span className="brand-mark"><PanelsTopLeft size={18} /></span><strong>Council</strong></div>
        <h1>擁有者登入</h1>
        <label>電子郵件<input name="email" type="email" autoComplete="username" required /></label>
        <label>密碼<input name="password" type="password" autoComplete="current-password" minLength={12} required /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary-button" disabled={busy !== null}><LockKeyhole size={15} />{busy === "password" ? "登入中" : "登入"}</button>
        {tailnetQuickLoginUiEnabled && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void completeLogin("tailnet", "/api/auth/tailnet-login")}><LogIn size={15} />{busy === "tailnet" ? "登入中" : "快速登入"}</button>}
        {disposableTestLoginUiEnabled && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void completeLogin("test", "/api/auth/test-login")}><LogIn size={15} />{busy === "test" ? "登入中" : "測試直接登入"}</button>}
      </form>
    </main>
  );
}
