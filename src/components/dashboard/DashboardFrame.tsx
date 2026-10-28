"use client";

import { usePathname } from "next/navigation";

/**
 * Pembungkus halaman dashboard. Di bawah /dashboard/admin ia menambah class
 * `hm-admin` (tema gelap ala admin heromarket, lihat globals.css) ke SELURUH
 * kerangka -- sidebar, nav bawah, dan isi halaman -- supaya semuanya serasi.
 * Halaman reseller/seller biasa tidak terpengaruh.
 */
export default function DashboardFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";
  const isAdmin = pathname === "/dashboard/admin" || pathname.startsWith("/dashboard/admin/");
  return (
    <div className={isAdmin ? "hm-admin min-h-dvh" : "min-h-dvh bg-hero-glow bg-no-repeat"}>{children}</div>
  );
}
