import Link from "next/link";
import { redirect } from "next/navigation";
import { Home, ShieldCheck } from "lucide-react";
import { getAdminUser } from "@/lib/require-admin";
import LogoutButton from "@/components/LogoutButton";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getAdminUser();
  if (!admin) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-[900px]">
      {/* Font Orbitron untuk judul/angka ala admin heromarket */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap" rel="stylesheet" />

      {/* Top bar ADMIN PANEL */}
      <div className="mb-4 flex items-center justify-between rounded-xl2 border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
            <ShieldCheck size={16} />
          </span>
          <div>
            <div className="font-display text-sm font-black hm-shimmer-text">ADMIN PANEL</div>
            <div className="text-[9px] text-ink-faint">HEROITBEST</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-dim transition-colors hover:bg-white/5 hover:text-ink"
          >
            <Home size={14} />
            <span className="hidden sm:inline">Beranda</span>
          </Link>
          <LogoutButton className="flex items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10 [&>span]:hidden" />
        </div>
      </div>
      {children}
    </div>
  );
}
