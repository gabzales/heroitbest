import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isStoreCryptoConfigured } from "@/lib/store/crypto";
import { autoSellPrice, resolveSellPrice } from "@/lib/store/pricing";

export type StoreVariant = {
  productId: string;
  durationId: string;
  productName: string;
  category: string;
  label: string;
  cost: number; // modal seller (tier/harga custom)
  price: number | null; // harga manual yang diset seller (null = ikut otomatis)
  autoPrice: number | null; // harga otomatis (modal + untung%), null kalau untung% belum diisi
  active: boolean; // false = seller menyembunyikan varian ini
};

export type StoreOrderRow = {
  id: string;
  status: string;
  productName: string;
  durationLabel: string;
  sellPrice: number;
  costPrice: number | null;
  buyerContact: string | null;
  failReason: string | null;
  createdAt: string;
};

export type MyStore = {
  configured: boolean; // STORE_SECRET_KEY valid
  store: {
    slug: string;
    name: string;
    contactWa: string;
    enabled: boolean;
    adminBlocked: boolean;
    hasKey: boolean;
    keyLast4: string | null;
    markupPct: number | null;
  } | null;
  balance: number;
  variants: StoreVariant[];
  orders: StoreOrderRow[];
  stats: { delivered: number; revenue: number; profit: number; needsAction: number };
};

type DurRow = { id: string; label: string; days: number };
type ProdRow = { id: string; name: string; category: string; product_durations: DurRow[] };

export async function getMyStore(userId: string): Promise<MyStore> {
  const empty: MyStore = {
    configured: isStoreCryptoConfigured(),
    store: null,
    balance: 0,
    variants: [],
    orders: [],
    stats: { delivered: 0, revenue: 0, profit: 0, needsAction: 0 },
  };
  const admin = createAdminSupabase();
  if (!admin) return empty;

  const [{ data: store }, { data: me }, { data: products }, { data: costs }, { data: prices }, { data: orders }] = await Promise.all([
    admin.from("stores").select("slug, name, contact_wa, enabled, admin_blocked, genspay_key_enc, genspay_key_last4, default_markup_pct").eq("user_id", userId).maybeSingle(),
    admin.from("users").select("balance").eq("id", userId).maybeSingle(),
    admin
      .from("products")
      .select("id, name, category, product_durations ( id, label, days )")
      .eq("active", true)
      .is("seller_id", null)
      .order("sort_order"),
    admin.rpc("effective_key_prices", { p_user_id: userId }),
    admin.from("store_prices").select("product_id, duration_id, price, active").eq("user_id", userId),
    admin
      .from("store_orders")
      .select("id, status, product_name, duration_label, sell_price, cost_price, buyer_contact, fail_reason, created_at")
      .eq("store_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const costMap = new Map<string, number>();
  for (const c of (costs ?? []) as { product_id: string; duration_id: string; price: number }[]) {
    costMap.set(`${c.product_id}\u0000${c.duration_id}`, Number(c.price));
  }
  const priceMap = new Map<string, { price: number; active: boolean }>();
  for (const p of (prices ?? []) as { product_id: string; duration_id: string; price: number; active: boolean }[]) {
    priceMap.set(`${p.product_id}\u0000${p.duration_id}`, { price: Number(p.price), active: p.active });
  }

  const variants: StoreVariant[] = [];
  for (const p of (products ?? []) as ProdRow[]) {
    for (const d of [...(p.product_durations ?? [])].sort((a, b) => a.days - b.days)) {
      const k = `${p.id}\u0000${d.id}`;
      const cost = costMap.get(k);
      if (cost === undefined) continue;
      const sp = priceMap.get(k);
      const markup = store && store.default_markup_pct !== null && store.default_markup_pct !== undefined ? Number(store.default_markup_pct) : null;
      variants.push({
        productId: p.id,
        durationId: d.id,
        productName: p.name,
        category: p.category,
        label: d.label,
        cost,
        price: sp ? sp.price : null,
        autoPrice: markup === null ? null : autoSellPrice(cost, markup),
        active: sp ? sp.active : true,
      });
    }
  }

  const orderRows: StoreOrderRow[] = ((orders ?? []) as {
    id: string; status: string; product_name: string; duration_label: string; sell_price: number;
    cost_price: number | null; buyer_contact: string | null; fail_reason: string | null; created_at: string;
  }[]).map((o) => ({
    id: o.id,
    status: o.status,
    productName: o.product_name,
    durationLabel: o.duration_label,
    sellPrice: Number(o.sell_price),
    costPrice: o.cost_price === null ? null : Number(o.cost_price),
    buyerContact: o.buyer_contact,
    failReason: o.fail_reason,
    createdAt: o.created_at,
  }));

  const delivered = orderRows.filter((o) => o.status === "delivered");
  return {
    configured: isStoreCryptoConfigured(),
    store: store
      ? {
          slug: store.slug as string,
          name: store.name as string,
          contactWa: (store.contact_wa as string | null) ?? "",
          enabled: Boolean(store.enabled),
          adminBlocked: Boolean(store.admin_blocked),
          hasKey: Boolean(store.genspay_key_enc),
          keyLast4: (store.genspay_key_last4 as string | null) ?? null,
          markupPct: store.default_markup_pct === null || store.default_markup_pct === undefined ? null : Number(store.default_markup_pct),
        }
      : null,
    balance: Number(me?.balance ?? 0),
    variants,
    orders: orderRows,
    stats: {
      delivered: delivered.length,
      revenue: delivered.reduce((s, o) => s + o.sellPrice, 0),
      profit: delivered.reduce((s, o) => s + (o.sellPrice - (o.costPrice ?? o.sellPrice)), 0),
      needsAction: orderRows.filter((o) => o.status === "paid_failed" || o.status === "paid").length,
    },
  };
}

export type PublicStoreItem = {
  productId: string;
  durationId: string;
  name: string;
  category: string;
  label: string;
  price: number;
};

export type PublicStore = { slug: string; name: string; contactWa: string | null; items: PublicStoreItem[] };

/** Data etalase publik toko seller. null kalau toko tidak ada/tutup/diblokir. */
export async function getPublicStore(slug: string): Promise<PublicStore | null> {
  const admin = createAdminSupabase();
  if (!admin || !isStoreCryptoConfigured()) return null;
  const { data: store } = await admin
    .from("stores")
    .select("user_id, slug, name, contact_wa, enabled, admin_blocked, genspay_key_enc, default_markup_pct")
    .eq("slug", slug)
    .maybeSingle();
  if (!store || !store.enabled || store.admin_blocked || !store.genspay_key_enc) return null;
  const sellerId = store.user_id as string;

  const [{ data: seller }, { data: prices }, { data: products }, { data: costs }] = await Promise.all([
    admin.from("users").select("balance, banned").eq("id", sellerId).maybeSingle(),
    admin.from("store_prices").select("product_id, duration_id, price, active").eq("user_id", sellerId),
    admin
      .from("products")
      .select("id, name, category, sort_order, product_durations ( id, label, days )")
      .eq("active", true)
      .is("seller_id", null)
      .order("sort_order"),
    admin.rpc("effective_key_prices", { p_user_id: sellerId }),
  ]);
  if (!seller || seller.banned) return null;
  const balance = Number(seller.balance ?? 0);

  const costMap = new Map<string, number>();
  for (const c of (costs ?? []) as { product_id: string; duration_id: string; price: number }[]) {
    costMap.set(`${c.product_id}\u0000${c.duration_id}`, Number(c.price));
  }
  const priceMap = new Map<string, { price: number; active: boolean }>();
  for (const p of (prices ?? []) as { product_id: string; duration_id: string; price: number; active: boolean }[]) {
    priceMap.set(`${p.product_id}\u0000${p.duration_id}`, { price: Number(p.price), active: p.active });
  }
  const markupPct = store.default_markup_pct === null || store.default_markup_pct === undefined ? null : Number(store.default_markup_pct);

  const items: PublicStoreItem[] = [];
  for (const p of (products ?? []) as ProdRow[]) {
    for (const d of [...(p.product_durations ?? [])].sort((a, b) => a.days - b.days)) {
      const k = `${p.id}\u0000${d.id}`;
      const cost = costMap.get(k);
      if (cost === undefined) continue;
      // Harga manual seller kalau ada, kalau tidak: otomatis (modal + untung%).
      const price = resolveSellPrice(priceMap.get(k), cost, markupPct);
      // Sembunyikan yang tidak bisa dipenuhi: tidak dijual, harga di bawah
      // modal, atau saldo seller kurang untuk mengambil key-nya.
      if (price === null || price < cost || balance < cost) continue;
      items.push({ productId: p.id, durationId: d.id, name: p.name, category: p.category, label: d.label, price });
    }
  }
  return { slug: store.slug as string, name: store.name as string, contactWa: (store.contact_wa as string | null) ?? null, items };
}

export type AdminStoreRow = {
  userId: string;
  slug: string;
  name: string;
  email: string;
  enabled: boolean;
  blocked: boolean;
  hasKey: boolean;
  orders: number;
  needsAction: number;
};

export async function getAdminStores(): Promise<AdminStoreRow[]> {
  const admin = createAdminSupabase();
  if (!admin) return [];
  const [{ data: stores }, { data: orders }] = await Promise.all([
    admin.from("stores").select("user_id, slug, name, enabled, admin_blocked, genspay_key_enc, users ( email )").order("created_at", { ascending: false }),
    admin.from("store_orders").select("store_user_id, status").limit(5000),
  ]);
  const total = new Map<string, number>();
  const action = new Map<string, number>();
  for (const o of (orders ?? []) as { store_user_id: string; status: string }[]) {
    if (o.status === "delivered") total.set(o.store_user_id, (total.get(o.store_user_id) ?? 0) + 1);
    if (o.status === "paid" || o.status === "paid_failed") action.set(o.store_user_id, (action.get(o.store_user_id) ?? 0) + 1);
  }
  return ((stores ?? []) as unknown as {
    user_id: string; slug: string; name: string; enabled: boolean; admin_blocked: boolean;
    genspay_key_enc: string | null; users: { email: string } | { email: string }[] | null;
  }[]).map((s) => {
    const u = Array.isArray(s.users) ? s.users[0] : s.users;
    return {
      userId: s.user_id,
      slug: s.slug,
      name: s.name,
      email: u?.email ?? "-",
      enabled: s.enabled,
      blocked: s.admin_blocked,
      hasKey: Boolean(s.genspay_key_enc),
      orders: total.get(s.user_id) ?? 0,
      needsAction: action.get(s.user_id) ?? 0,
    };
  });
}
