import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";

// ═══════════════════════════════════════════════════════
// Supplier kedua: CHEATGAME.ONLINE ("CGS" / "CGO"), Reseller API.
// Dipakai untuk product_durations stock_mode = 'auto' yang provider_item_id-nya
// berawalan "cg:" -- key diambil langsung dari akun reseller kita di
// cheatgame.online setiap ada order (sama konsepnya dengan vipbestmods/IPM).
//
// Format provider_item_id: "cg:<product_id CHEATGAME>" (angka id produk).
//
// API (header X-API-Key, satu endpoint reseller_api.php, dibedakan `action`),
// bentuk response SAMA dengan adapter CHEATGAME di heromarket (providers/cheatgame.js,
// sudah dikonfirmasi dari response asli):
//   GET  ?action=balance       -> { balance, currency }
//   GET  ?action=products      -> daftar produk { id, brand, name, price_usd, price_idr, stock, status }
//   POST { action:"order", external_ref, product_id, quantity, customer_name, customer_email }
//        -> { data: { order_id, status, delivery: [{ key, download_url }] } }
//   GET  ?action=order_status&order_id=  -> { data: { status, delivery: [...] } }
//
// Kredensial: app_settings row 'cheatgame_api' { apiKey, baseUrl },
// fallback env CHEATGAME_API_KEY / CHEATGAME_BASE_URL. API Key yang dipakai
// BOLEH sama dengan yang dipakai di heromarket.
// ═══════════════════════════════════════════════════════

const DEFAULT_BASE_URL = "https://cheatgame.online/reseller_api.php";
const REQUEST_TIMEOUT_MS = 25000;
const CATALOG_TTL_MS = 3 * 60 * 1000;
// Kalau order sudah diterima tapi key belum langsung dikirim, tanya status
// beberapa kali sebelum menyerah (Vercel function max ~60 dtk di route beli).
const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 2500;

export const CHEATGAME_PREFIX = "cg:";

type CheatgameConfig = { apiKey: string; baseUrl: string };

export type CheatgameResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; code: string; message: string; status?: number };

export type CheatgameCatalogItem = {
  /** Nilai yang disimpan di product_durations.provider_item_id */
  id: string;
  product_name: string;
  item_name: string;
  category?: string;
  price?: number;
  stock?: number | null;
};

let cachedConfig: CheatgameConfig | null = null;
let cachedCatalog: { at: number; items: CheatgameCatalogItem[] } | null = null;

export function isCheatgameItem(providerItemId: string | null | undefined): boolean {
  return typeof providerItemId === "string" && providerItemId.startsWith(CHEATGAME_PREFIX);
}

export function makeCheatgameItemId(productId: string | number): string {
  return `${CHEATGAME_PREFIX}${productId}`;
}

export function parseCheatgameItemId(providerItemId: string): number | null {
  if (!isCheatgameItem(providerItemId)) return null;
  const n = Number(providerItemId.slice(CHEATGAME_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function getCheatgameConfig(): Promise<CheatgameConfig> {
  if (cachedConfig) return cachedConfig;
  let stored: Partial<CheatgameConfig> = {};
  const admin = createAdminSupabase();
  if (admin) {
    const { data } = await admin.from("app_settings").select("value").eq("key", "cheatgame_api").maybeSingle();
    if (data?.value) stored = data.value as Partial<CheatgameConfig>;
  }
  cachedConfig = {
    apiKey: (stored.apiKey || process.env.CHEATGAME_API_KEY || "").trim(),
    baseUrl: String(stored.baseUrl || process.env.CHEATGAME_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
  };
  return cachedConfig;
}

export function invalidateCheatgameCache() {
  cachedConfig = null;
  cachedCatalog = null;
}

export async function isCheatgameConfigured(): Promise<boolean> {
  return Boolean((await getCheatgameConfig()).apiKey);
}

type Body = Record<string, unknown>;

async function doRequest(method: "GET" | "POST", params: Record<string, string>, body?: Body): Promise<CheatgameResult<Body>> {
  const { apiKey, baseUrl } = await getCheatgameConfig();
  if (!apiKey) {
    return { success: false, code: "NOT_CONFIGURED", message: "API Key CHEATGAME belum diatur di panel admin." };
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { success: false, code: "INVALID_BASE_URL", message: "Base URL CHEATGAME tidak valid." };
  }
  if (url.protocol !== "https:") {
    return { success: false, code: "INVALID_BASE_URL", message: "Base URL CHEATGAME harus https://." };
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      success: false,
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      message: timedOut ? "Timeout menghubungi CHEATGAME." : "Gagal menghubungi CHEATGAME.",
    };
  }
  const text = await res.text();
  let json: Body | null = null;
  try {
    json = JSON.parse(text) as Body;
  } catch {
    /* bukan JSON */
  }
  const msg = (json && (json.message || json.error)) as string | undefined;
  if (!res.ok || !json || json.success === false || (json.error && typeof json.error === "string")) {
    return {
      success: false,
      code: res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : `HTTP_${res.status}`,
      message: msg || (json ? `CHEATGAME menolak request (HTTP ${res.status})` : `Respons CHEATGAME bukan JSON (HTTP ${res.status}): ${text.slice(0, 120)}`),
      status: res.status,
    };
  }
  return { success: true, data: json };
}

function pickList(body: Body): Record<string, unknown>[] {
  const data = body.data as Body | undefined;
  const candidates: unknown[] = [body.data, body.products, data?.products, data?.data, body.result, body];
  const found = candidates.find((c) => Array.isArray(c));
  return (found as Record<string, unknown>[] | undefined) ?? [];
}

/** Katalog produk CHEATGAME (hanya yang aktif), satu baris per produk. */
export async function getCheatgameCatalog(opts?: { fresh?: boolean }): Promise<CheatgameResult<CheatgameCatalogItem[]>> {
  if (!opts?.fresh && cachedCatalog && Date.now() - cachedCatalog.at < CATALOG_TTL_MS) {
    return { success: true, data: cachedCatalog.items };
  }
  const r = await doRequest("GET", { action: "products" });
  if (!r.success) return r;
  const list = pickList(r.data);
  if (!list.length) {
    return { success: false, code: "BAD_RESPONSE", message: `Struktur katalog CHEATGAME tidak dikenali: ${JSON.stringify(r.data).slice(0, 200)}` };
  }
  const items: CheatgameCatalogItem[] = [];
  for (const it of list) {
    const id = it.id ?? it.product_id;
    if (id === undefined || id === null || id === "") continue;
    if ((it.status ?? "active") !== "active") continue;
    const brand = typeof it.brand === "string" ? it.brand : "";
    const name = String(it.name ?? it.title ?? `Produk ${id}`);
    const idr = it.price_idr !== undefined && it.price_idr !== null ? Number(it.price_idr) : null;
    const usd = Number(it.price_usd ?? it.price ?? 0);
    items.push({
      id: makeCheatgameItemId(String(id)),
      product_name: brand || name,
      item_name: name,
      category: brand || undefined,
      price: idr !== null && Number.isFinite(idr) ? idr : Number.isFinite(usd) ? usd : undefined,
      stock: it.stock !== undefined && it.stock !== null ? Number(it.stock) : null,
    });
  }
  cachedCatalog = { at: Date.now(), items };
  return { success: true, data: items };
}

export async function getCheatgameBalance(): Promise<CheatgameResult<{ balance: number; currency: string }>> {
  const r = await doRequest("GET", { action: "balance" });
  if (!r.success) return r;
  const d = (r.data.data ?? {}) as Body;
  const raw = r.data.balance ?? d.balance;
  const balance = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(balance)) {
    return { success: false, code: "BAD_RESPONSE", message: "Respons saldo CHEATGAME tidak dikenali." };
  }
  return { success: true, data: { balance, currency: String(r.data.currency ?? d.currency ?? "USD") } };
}

function normalizeStatus(raw: unknown): "success" | "failed" | "processing" | "pending" {
  const s = String(raw ?? "").toLowerCase();
  if (["success", "completed", "done", "paid"].includes(s)) return "success";
  if (["failed", "error", "cancelled", "canceled"].includes(s)) return "failed";
  if (["processing", "in_progress"].includes(s)) return "processing";
  return "pending";
}

function deliveryKeyOf(body: Body): string | null {
  const d = (body.data ?? {}) as Body;
  const delivery = Array.isArray(d.delivery) ? (d.delivery[0] as Body | undefined) : undefined;
  const key = delivery?.key ?? d.key ?? body.key;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function mapErrorCode(message: string): string {
  const m = message.toLowerCase();
  if (/saldo|balance|insufficient|kurang/.test(m)) return "INSUFFICIENT_BALANCE";
  if (/stok|stock|habis|out of/.test(m)) return "OUT_OF_STOCK";
  if (/inactive|nonaktif|disabled/.test(m)) return "PRODUCT_INACTIVE";
  if (/rate|too many|terlalu banyak/.test(m)) return "RATE_LIMITED";
  return "SUPPLIER_UNAVAILABLE";
}

/**
 * Order 1 key dari CHEATGAME. idempotencyKey dipakai sebagai external_ref
 * (stabil untuk order yang sama). Kalau key belum langsung ada di response,
 * status order ditanyakan beberapa kali; kalau tetap belum ada, error
 * menyertakan order_id CHEATGAME supaya owner bisa melacaknya manual.
 */
export async function orderCheatgameKey({
  providerItemId,
  idempotencyKey,
}: {
  providerItemId: string;
  idempotencyKey: string;
  customerReference?: string; // diterima agar signature sama dgn vipbestmods; tidak dikirim ke CHEATGAME
}): Promise<CheatgameResult<{ codes: string[] }>> {
  const productId = parseCheatgameItemId(providerItemId);
  if (!productId) {
    return { success: false, code: "MISSING_ITEM_ID", message: `Mapping CHEATGAME "${providerItemId}" tidak valid.` };
  }
  const r = await doRequest("POST", {}, {
    action: "order",
    external_ref: idempotencyKey.slice(0, 100),
    product_id: productId,
    quantity: 1,
    customer_name: "heroitbest",
    customer_email: "noreply@heroitbest.com",
  });
  if (!r.success) return { ...r, code: r.code === "UNAUTHORIZED" ? "SUPPLIER_UNAVAILABLE" : mapErrorCode(r.message) };

  const key = deliveryKeyOf(r.data);
  if (key) return { success: true, data: { codes: [key] } };

  const d = (r.data.data ?? {}) as Body;
  const orderId = d.order_id ?? r.data.order_id;
  if (normalizeStatus(d.status ?? r.data.status) === "failed") {
    return { success: false, code: "SUPPLIER_UNAVAILABLE", message: `Order CHEATGAME gagal (order_id ${orderId ?? "-"}).` };
  }
  if (orderId === undefined || orderId === null) {
    return { success: false, code: "SUPPLIER_UNAVAILABLE", message: "CHEATGAME menerima order tapi tidak mengirim order_id maupun key." };
  }
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    const s = await doRequest("GET", { action: "order_status", order_id: String(orderId) });
    if (!s.success) continue;
    const k = deliveryKeyOf(s.data);
    if (k) return { success: true, data: { codes: [k] } };
    const sd = (s.data.data ?? {}) as Body;
    if (normalizeStatus(sd.status ?? s.data.status) === "failed") {
      return { success: false, code: "SUPPLIER_UNAVAILABLE", message: `Order CHEATGAME gagal (order_id ${orderId}).` };
    }
  }
  return {
    success: false,
    code: "SUPPLIER_UNAVAILABLE",
    message: `Order CHEATGAME ${orderId} belum mengirim key setelah ${POLL_ATTEMPTS} kali cek -- cek manual di dashboard cheatgame.online (saldo mungkin sudah terpotong).`,
  };
}
