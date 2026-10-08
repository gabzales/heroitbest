export type Product = {
  id: string;
  name: string;
  category: string;
  // Nama toko kalau ini listing marketplace milik seller; null = produk platform sendiri.
  sellerName?: string | null;
  durations: { id: string; label: string; days: number; price: number }[];
};

export type AdminDuration = {
  id: string;
  label: string;
  days: number;
  price: number;
  stockMode: "manual" | "auto";
  providerItemId: string | null;
  manualStock: number; // count of unused key_stock rows
};

export type AdminProduct = {
  id: string;
  name: string;
  category: string;
  active: boolean;
  sortOrder: number;
  durations: AdminDuration[];
};

export type DisputeStatus = "open" | "resolved_refund" | "resolved_release" | "dismissed";

export type GeneratedKey = {
  id: string;
  productName: string;
  duration: string;
  keyString: string;
  createdAt: string; // ISO date
  // Marketplace: hanya terisi untuk key dari listing seller.
  fromSeller?: boolean;
  canDispute?: boolean; // masih dalam masa tahan, belum pernah dikomplain
  disputeStatus?: DisputeStatus | null;
  refunded?: boolean;
};

export type TopupTx = {
  id: string;
  nominal: number;
  bonus: number;
  total: number;
  method: "QRIS";
  status: "success" | "pending" | "failed" | "expired";
  createdAt: string; // ISO date
};

export type ResellerUser = {
  id: string;
  name: string;
  email: string;
  avatarSeed: string;
  balance: number;
  role: "user" | "admin";
  verified: boolean;
  theme: string;
};
