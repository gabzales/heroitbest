// Saklar fitur. Seller/marketplace MATI secara default (sistem dibuat simpel ala
// vipbestmods: admin yang isi produk & key, pengguna cuma beli key).
// Nyalakan lagi dengan env SELLER_ENABLED=true (lalu redeploy) -- tidak ada data
// yang dihapus saat dimatikan.
export const SELLER_ENABLED = process.env.SELLER_ENABLED === "true";

/** Halaman dashboard yang hanya hidup saat seller aktif. */
export const SELLER_ONLY_PAGE_PREFIXES = [
  "/dashboard/seller",
  "/dashboard/admin/sellers",
  "/dashboard/admin/withdrawals",
  "/dashboard/admin/disputes",
  "/dashboard/admin/settings/marketplace",
];
