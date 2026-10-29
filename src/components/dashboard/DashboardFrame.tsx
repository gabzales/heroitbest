"use client";

import { usePathname } from "next/navigation";

/**
 * Pembungkus halaman dashboard. Di bawah /dashboard/admin ia menambah class
 * `hm-admin` (tema gelap ala admin heromarket, lihat globals.css) ke SELURUH
 * kerangka -- sidebar, nav bawah, dan isi halaman -- supaya semuanya serasi.
 * Halaman pengguna biasa memakai varian biru `hm-vip` (ala vipbestmods).
 */
export default function DashboardFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";
  const isAdmin = pathname === "/dashboard/admin" || pathname.startsWith("/dashboard/admin/");
  return (
    <div className={isAdmin ? "hm-admin min-h-dvh" : "hm-admin hm-vip min-h-dvh"}>{children}</div>
  );
}
