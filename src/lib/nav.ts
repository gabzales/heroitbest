import {
  LayoutGrid,
  History,
  Wallet,
  Receipt,
  UserRound,
  ShieldCheck,
  KeyRound,
} from "lucide-react";

// Menu ala vipbestmods: Dashboard, Beli Key, History, Profil (+ Top Up di sidebar desktop).
export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid, exact: true },
  { href: "/dashboard/generate", label: "Beli Key", icon: KeyRound, exact: false },
  { href: "/dashboard/history/keys", label: "History", icon: History, exact: false },
  { href: "/dashboard/topup", label: "Top Up", icon: Wallet, exact: false },
  { href: "/dashboard/history/topup", label: "History Top Up", icon: Receipt, exact: false },
  { href: "/dashboard/profile", label: "Profil", icon: UserRound, exact: false },
] as const;

// Only shown to role === 'admin' -- Sidebar appends this itself, see
// src/lib/require-admin.ts for the server-side gate that actually
// protects the routes underneath it.
export const ADMIN_NAV_ITEM = {
  href: "/dashboard/admin",
  label: "Admin",
  icon: ShieldCheck,
  exact: false,
} as const;

// Tab bawah mobile: persis 4 menu seperti vipbestmods. Top Up diakses dari
// Dashboard & Profil; Admin ditambah otomatis oleh BottomNav untuk role admin.
export const MOBILE_TABS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid, exact: true },
  { href: "/dashboard/generate", label: "Beli Key", icon: KeyRound, exact: false },
  { href: "/dashboard/history/keys", label: "History", icon: History, exact: false },
  { href: "/dashboard/profile", label: "Profil", icon: UserRound, exact: false },
] as const;
