import "server-only";
import { randomBytes } from "crypto";
import { getGenspayConfig } from "@/lib/provider/genspay";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
export const MIN_PRICE = 1000; // minimum transaksi GensPay

export function normalizeSlug(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function newOrderRefs() {
  // merchant_ref: huruf/angka/dash, <= 50 karakter (syarat GensPay)
  return {
    merchantRef: `so-${randomBytes(12).toString("hex")}`,
    token: randomBytes(24).toString("base64url"),
  };
}

export function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : request.headers.get("x-real-ip") || "").trim();
  return ip || "unknown";
}

export function getAppUrl(request: Request): string {
  const env = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  const host = request.headers.get("host");
  return host ? `https://${host}` : "https://heroitbest.web.id";
}

export type QrisResult =
  | { ok: true; qrString: string; amount: number; expiredAt: string | number | null }
  | { ok: false; status: number; message: string };

/**
 * Buat transaksi QRIS di GensPay MEMAKAI API key seller. Base URL tetap dari
 * konfigurasi platform (seller tidak boleh menentukan URL -- cegah SSRF).
 * GensPay menambah fee DI ATAS nominal: pembeli bayar `amount` (gross),
 * seller menerima nominal penuh (net).
 */
export async function createSellerQris(opts: {
  apiKey: string;
  orderId: string;
  amount: number;
  callbackUrl: string;
}): Promise<QrisResult> {
  const { baseUrl } = await getGenspayConfig();
  if (!baseUrl) return { ok: false, status: 503, message: "Gateway belum dikonfigurasi." };
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/transaction/create`, {
      method: "POST",
      headers: { "X-API-Key": opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: opts.amount,
        order_id: opts.orderId,
        payment_method: "qris",
        callback_url: opts.callbackUrl,
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 502, message: "Gagal menghubungi GensPay." };
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    data?: { qr_string?: string; amount?: number; expiry_time?: string | number };
  } | null;
  if (res.status === 401) return { ok: false, status: 401, message: "API key GensPay ditolak." };
  if (!res.ok || !json?.success || !json.data?.qr_string) {
    return { ok: false, status: 502, message: json?.error || "GensPay menolak transaksi." };
  }
  return {
    ok: true,
    qrString: json.data.qr_string,
    amount: json.data.amount ?? opts.amount,
    expiredAt: json.data.expiry_time ?? null,
  };
}
