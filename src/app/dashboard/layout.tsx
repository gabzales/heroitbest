import { redirect } from "next/navigation";
import Sidebar from "@/components/dashboard/Sidebar";
import BottomNav from "@/components/dashboard/BottomNav";
import { ThemeProvider } from "@/components/ThemeProvider";
import { getCurrentUserResult } from "@/lib/data/user";
import LogoutButton from "@/components/LogoutButton";
import type { ThemeId } from "@/lib/theme";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, hasSession, error } = await getCurrentUserResult();
  if (!user && !hasSession) redirect("/login");
  if (!user) {
    // Login sukses tapi profil tidak terbaca. Jangan lempar ke /login
    // (bikin loop membingungkan) -- tampilkan penyebab sebenarnya.
    return (
      <div className="mx-auto flex min-h-dvh max-w-[520px] flex-col justify-center gap-4 px-5">
        <h1 className="font-display text-xl font-bold">Akun belum siap dipakai</h1>
        <p className="text-sm text-ink-dim">
          Kamu sudah login, tapi data profil di database tidak bisa dibaca. Biasanya karena
          <code className="mx-1">supabase/setup.sql</code> belum dijalankan penuh, atau akun ini dibuat di
          project Supabase yang berbeda dari env di Vercel.
        </p>
        <pre className="whitespace-pre-wrap rounded-xl border border-border bg-surface-2 p-3 text-xs">{error}</pre>
        <LogoutButton className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold" />
      </div>
    );
  }

  return (
    // Nested ThemeProvider, seeded from this account's saved theme
    // (public.users.theme) -- takes over from the root layout's
    // localStorage-only ThemeProvider for everything under /dashboard,
    // so palette choice follows the ACCOUNT rather than just this
    // device. See ThemeProvider.tsx for how initialTheme reconciles
    // with the pre-paint script's localStorage guess.
    <ThemeProvider initialTheme={user.theme as ThemeId}>
      <div className="min-h-dvh bg-hero-glow bg-no-repeat">
        <Sidebar user={user} />
        <BottomNav user={user} />
        <main className="mx-auto max-w-[1180px] px-4 pb-24 pt-4 sm:px-6 sm:pt-6 lg:pb-12 lg:pl-[264px] lg:pr-8 lg:pt-8">
          {children}
        </main>
      </div>
    </ThemeProvider>
  );
}
