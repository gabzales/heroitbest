// Data contoh untuk MODE DEMO (Supabase belum terhubung / env belum diisi).
// Hanya dipakai di client lewat call() di api.ts -- tidak pernah menyentuh
// database. Bentuknya harus sama dengan respons /api/seller/*.

const durations = [
  { id: "1d-a1", label: "1 HARI", days: 1, price: 12000, stock_mode: "manual", provider_item_id: null, stock_count: 18 },
  { id: "7d-b2", label: "7 HARI", days: 7, price: 45000, stock_mode: "manual", provider_item_id: null, stock_count: 6 },
  { id: "30d-c3", label: "30 HARI (Auto)", days: 30, price: 120000, stock_mode: "auto", provider_item_id: "55", stock_count: 0 },
];

export function demoGet(url: string): unknown {
  const path = url.split("?")[0];

  if (path === "/api/seller/me") {
    return {
      seller: {
        storeName: "Toko Contoh", storeSlug: "toko-contoh", bankName: "BCA", bankAccountNumber: "1234567890",
        bankAccountHolder: "Nama Pemilik", status: "active", commissionPercent: 10,
      },
      balance: { pending: 45000, available: 120000, paidOut: 300000 },
      holdHours: 48, autoEnabled: true,
    };
  }
  if (path === "/api/seller/products") {
    return {
      products: [
        { id: "toko-contoh-cheat-ff", name: "Cheat FF Android", category: "Free Fire", active: true,
          product_durations: durations.map(({ id, label, price, stock_mode }) => ({ id, label, price, stock_mode })) },
        { id: "toko-contoh-proxy", name: "Proxy Premium", category: "General", active: false, product_durations: [] },
      ],
    };
  }
  if (/^\/api\/seller\/products\/[^/]+$/.test(path)) {
    return { product: { id: "toko-contoh-cheat-ff", name: "Cheat FF Android", category: "Free Fire", active: true, product_durations: durations } };
  }
  if (/\/stock$/.test(path)) {
    return { keys: Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, key_string: `DEMO-XXXX-${1000 + i}-YYYY` })) };
  }
  if (path === "/api/seller/provider-catalog") {
    return {
      enabled: true,
      items: [
        { id: "55", name: "Contoh Produk — 30 HARI", minSellPrice: 96000 },
        { id: "56", name: "Contoh Produk — 7 HARI", minSellPrice: 39000 },
      ],
    };
  }
  if (path === "/api/seller/sales") {
    const now = Date.now();
    return {
      sales: [
        { id: "s1", product_name: "Cheat FF Android", duration_label: "7 HARI", price: 45000, seller_earning: 40500, commission_amount: 4500,
          held_until: new Date(now + 20 * 3600e3).toISOString(), created_at: new Date(now - 28 * 3600e3).toISOString(), disputed: false },
        { id: "s2", product_name: "Cheat FF Android", duration_label: "1 HARI", price: 12000, seller_earning: 10800, commission_amount: 1200,
          held_until: new Date(now - 10 * 3600e3).toISOString(), created_at: new Date(now - 60 * 3600e3).toISOString(), disputed: false },
        { id: "s3", product_name: "Cheat FF Android", duration_label: "30 HARI (Auto)", price: 120000, seller_earning: 108000, commission_amount: 12000,
          held_until: new Date(now + 5 * 3600e3).toISOString(), created_at: new Date(now - 43 * 3600e3).toISOString(), disputed: true },
      ],
    };
  }
  if (path === "/api/seller/withdrawals") {
    const now = Date.now();
    return {
      withdrawals: [
        { id: "w1", amount: 100000, status: "pending", admin_note: null, requested_at: new Date(now - 3 * 3600e3).toISOString() },
        { id: "w2", amount: 300000, status: "paid", admin_note: "Transfer ref 8812", requested_at: new Date(now - 5 * 86400e3).toISOString() },
      ],
    };
  }
  return undefined;
}
