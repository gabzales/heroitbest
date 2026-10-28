import "server-only";
import crypto from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";

// ══════════════════════════════════════════════════════════════════
// Pakasir API v2 (app.pakasir.com) -- dokumentasi resmi: pakasir.com/p/create-transaction
//   Auth      : header  X-Api-Key: <api_key>   (slug + api_key ada di bawah halaman Detail Proyek)
//   Create    : POST /api/v2/create-transaction/{slug}/{order_id}   body { method:"qris", amount }
//               "find or create": panggilan ulang dengan order_id+amount sama = respons yang sama
//   Status    : GET  /api/v2/transaction-status/{slug}/{txn_id}     (maks 1x / 4 detik per transaksi)
//   Cancel    : POST /api/v2/cancel-transaction/{slug}/{txn_id}
//   Webhook   : POST ke Webhook URL proyek, header  X-Secret: <secret proyek>,
//               body { txn_id, order_id, amount, is_sandbox, status:"completed", completed_at }
//               (dikirim HANYA saat transaksi berhasil; retry tidak terdokumentasi)
//   Status    : pending | completed | canceled
//   Batas QRIS: Rp500 - Rp10.000.000, rate limit create 2 req/detik
//   API v1 DIHENTIKAN 20 Oktober 2026 -- file ini hanya memakai v2.
//
// Kredensial: DB dulu (app_settings key 'pakasir', diisi lewat panel admin), env sebagai cadangan.
// ══════════════════════════════════════════════════════════════════

const DEFAULT_BASE_URL = "https://app.pakasir.com";

export type PakasirConfig = { slug: string; apiKey: string; webhookSecret: string; baseUrl: string };

const CONFIG_CACHE_TTL_MS = 30_000;
let cachedConfig: PakasirConfig | null = null;
let cachedAt = 0;

export async function getPakasirConfig(): Promise<PakasirConfig> {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_CACHE_TTL_MS) return cachedConfig;
  let stored: Partial<PakasirConfig> = {};
  const admin = createAdminSupabase();
  if (admin) {
    const { data } = await admin.from("app_settings").select("value").eq("key", "pakasir").maybeSingle();
    if (data?.value) stored = data.value as Partial<PakasirConfig>;
  }
  const config: PakasirConfig = {
    slug: (stored.slug || process.env.PAKASIR_SLUG || "").trim(),
    apiKey: (stored.apiKey || process.env.PAKASIR_API_KEY || "").trim(),
    webhookSecret: (stored.webhookSecret || process.env.PAKASIR_WEBHOOK_SECRET || "").trim(),
    baseUrl: (stored.baseUrl || process.env.PAKASIR_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
  };
  cachedConfig = config;
  cachedAt = Date.now();
  return config;
}

export function invalidatePakasirConfigCache() {
  cachedConfig = null;
  cachedAt = 0;
}

export async function isPakasirConfigured(): Promise<boolean> {
  const { slug, apiKey, baseUrl } = await getPakasirConfig();
  return Boolean(slug && apiKey && baseUrl);
}

// ── Gateway aktif: saklar global (app_settings key 'payment_gateway' = { active }).
// Nilai lama 'stenly' (sudah dihapus) otomatis dianggap 'genspay'. Default 'genspay'
// supaya toko yang sudah jalan tidak pindah gateway diam-diam. ──
export type ActivePaymentGateway = "genspay" | "pakasir" | "wijayapay";

export async function getActivePaymentGateway(): Promise<ActivePaymentGateway> {
  const admin = createAdminSupabase();
  if (!admin) return "genspay";
  const { data } = await admin.from("app_settings").select("value").eq("key", "payment_gateway").maybeSingle();
  const active = (data?.value as { active?: string } | null)?.active;
  return active === "pakasir" || active === "wijayapay" ? active : "genspay";
}

type Json = Record<string, unknown>;

/** Respons v2 belum pasti dibungkus atau tidak -- terima bentuk datar, {payment}, {transaction}, atau {data}. */
function unwrap(json: unknown): Json {
  const j = (json ?? {}) as Json;
  for (const k of ["payment", "transaction", "data"]) {
    const inner = j[k];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Json;
  }
  return j;
}

function errText(json: unknown, fallback: string): string {
  const j = (json ?? {}) as Json;
  const e = j.error ?? j.message;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object" && typeof (e as Json).message === "string") return (e as Json).message as string;
  return fallback;
}

async function pakasirFetch(
  cfg: PakasirConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<{ ok: true; status: number; json: unknown; raw: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "X-Api-Key": cfg.apiKey,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const raw = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* bukan JSON */
    }
    if (!res.ok) return { ok: false, message: errText(json, `Pakasir menolak request (HTTP ${res.status}).`) };
    return { ok: true, status: res.status, json, raw };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, message: aborted ? "Timeout menghubungi Pakasir (>15 detik)." : "Pakasir tidak terjangkau." };
  }
}

// ── Create (find-or-create) ──
export type PakasirCreateResult =
  | {
      success: true;
      txnId: string;
      qrString: string;
      amount: number;
      fee: number;
      totalPayment: number;
      expiredAt: string | null;
      isSandbox: boolean;
    }
  | { success: false; message: string };

export async function createPakasirTransaction(params: { orderId: string; amount: number }): Promise<PakasirCreateResult> {
  const cfg = await getPakasirConfig();
  if (!cfg.slug || !cfg.apiKey) return { success: false, message: "Pakasir belum dikonfigurasi (Slug/API Key kosong)." };
  const r = await pakasirFetch(
    cfg,
    `/api/v2/create-transaction/${encodeURIComponent(cfg.slug)}/${encodeURIComponent(params.orderId)}`,
    { method: "POST", body: { method: "qris", amount: params.amount } }
  );
  if (!r.ok) return { success: false, message: r.message };
  const p = unwrap(r.json);
  const qr = typeof p.qr_string === "string" ? p.qr_string : typeof p.payment_number === "string" ? p.payment_number : "";
  const txnId = typeof p.txn_id === "string" ? p.txn_id : "";
  if (!qr || !txnId) return { success: false, message: "Respons Pakasir tidak lengkap (qr_string/txn_id tidak ditemukan)." };
  const amount = Number(p.amount ?? params.amount);
  const fee = Number(p.fee ?? 0);
  return {
    success: true,
    txnId,
    qrString: qr,
    amount,
    fee,
    totalPayment: Number(p.total_payment ?? amount + fee),
    expiredAt: typeof p.expired_at === "string" ? p.expired_at : null,
    isSandbox: p.is_sandbox === true,
  };
}

// ── Status (txn_id wajib; maks 1x / 4 detik per transaksi) ──
export type PakasirStatusResult =
  | { success: true; status: string; orderId: string | null; amount: number | null }
  | { success: false; message: string };

export async function getPakasirStatus(txnId: string): Promise<PakasirStatusResult> {
  const cfg = await getPakasirConfig();
  if (!cfg.slug || !cfg.apiKey) return { success: false, message: "Pakasir belum dikonfigurasi." };
  const r = await pakasirFetch(
    cfg,
    `/api/v2/transaction-status/${encodeURIComponent(cfg.slug)}/${encodeURIComponent(txnId)}`,
    { method: "GET" }
  );
  if (!r.ok) return { success: false, message: r.message };
  const p = unwrap(r.json);
  if (typeof p.status !== "string") return { success: false, message: "Respons status Pakasir tidak dikenali." };
  return {
    success: true,
    status: p.status.toLowerCase(),
    orderId: typeof p.order_id === "string" ? p.order_id : null,
    amount: typeof p.amount === "number" ? p.amount : null,
  };
}

export async function cancelPakasirTransaction(txnId: string): Promise<{ success: boolean; message: string }> {
  const cfg = await getPakasirConfig();
  if (!cfg.slug || !cfg.apiKey) return { success: false, message: "Pakasir belum dikonfigurasi." };
  const r = await pakasirFetch(
    cfg,
    `/api/v2/cancel-transaction/${encodeURIComponent(cfg.slug)}/${encodeURIComponent(txnId)}`,
    { method: "POST" }
  );
  if (!r.ok) return { success: false, message: r.message };
  const p = unwrap(r.json);
  return { success: true, message: typeof p.message === "string" ? p.message : "OK" };
}

/** Bandingkan header X-Secret dengan secret proyek (tahan timing-attack). */
export function verifyPakasirSecret(headerValue: string | null, secret: string): boolean {
  if (!headerValue || !secret) return false;
  const a = crypto.createHash("sha256").update(headerValue).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Test & Debug untuk panel admin ──
export type PakasirTestStep = { step: string; ok: boolean; detail: string };
export type PakasirTestResult = { ok: boolean; steps: PakasirTestStep[]; elapsedMs?: number; rawResponse?: string };

/**
 * Menguji seluruh jalur v2 dengan transaksi uji Rp1.000 yang langsung DIBATALKAN:
 * config -> create -> status -> cancel. Tidak ada uang yang berpindah.
 * (Dokumentasi v2 tidak menyediakan endpoint simulasi bayar; untuk uji webhook
 *  gunakan fitur simulasi di dashboard Pakasir saat proyek masih Sandbox.)
 */
export async function testPakasirConnection(): Promise<PakasirTestResult> {
  const steps: PakasirTestStep[] = [];
  const cfg = await getPakasirConfig();
  const started = Date.now();

  steps.push({
    step: "config",
    ok: Boolean(cfg.slug && cfg.apiKey),
    detail: cfg.slug && cfg.apiKey ? `Base URL: ${cfg.baseUrl} · Slug: ${cfg.slug}` : "Slug atau API Key kosong.",
  });
  steps.push({
    step: "webhook_secret",
    ok: Boolean(cfg.webhookSecret),
    detail: cfg.webhookSecret
      ? "Webhook Secret terisi (header X-Secret akan dicek)."
      : "Webhook Secret kosong -- webhook tetap diverifikasi lewat API status, tapi sebaiknya diisi.",
  });
  if (!cfg.slug || !cfg.apiKey) return { ok: false, steps };

  const orderId = `test-${Date.now().toString(36)}`;
  steps.push({ step: "order_id", ok: true, detail: `"${orderId}"` });

  const created = await createPakasirTransaction({ orderId, amount: 1000 });
  if (!created.success) {
    steps.push({ step: "create", ok: false, detail: created.message });
    return { ok: false, steps, elapsedMs: Date.now() - started };
  }
  steps.push({
    step: "create",
    ok: true,
    detail: `Transaksi dibuat: txn_id=${created.txnId}, fee Rp${created.fee}, total bayar Rp${created.totalPayment}, mode ${
      created.isSandbox ? "SANDBOX" : "LIVE"
    }`,
  });
  steps.push({ step: "qr_string", ok: true, detail: `QR diterima (${created.qrString.length} karakter).` });

  const st = await getPakasirStatus(created.txnId);
  steps.push({
    step: "status",
    ok: st.success && st.status === "pending",
    detail: st.success ? `Status transaksi uji: ${st.status}` : st.message,
  });

  const cancelled = await cancelPakasirTransaction(created.txnId);
  steps.push({
    step: "cancel",
    ok: cancelled.success,
    detail: cancelled.success ? `Transaksi uji dibatalkan (${cancelled.message}).` : cancelled.message,
  });

  const ok = steps.every((s) => s.ok || s.step === "webhook_secret");
  return { ok, steps, elapsedMs: Date.now() - started };
}
