// Murni (tanpa server-only) supaya bisa dipakai server DAN komponen client.
export const STORE_MIN_PRICE = 1000; // minimum transaksi GensPay
export const MAX_MARKUP_PCT = 500;

/** Harga otomatis = modal + untung%, dibulatkan ke atas per Rp100, min Rp1.000. */
export function autoSellPrice(cost: number, markupPct: number): number {
  const raw = cost * (1 + markupPct / 100);
  return Math.max(STORE_MIN_PRICE, Math.ceil(raw / 100) * 100);
}

/**
 * Harga jual efektif satu varian.
 * - Ada harga manual (override): dipakai kalau aktif, null kalau dimatikan seller.
 * - Tidak ada override: pakai harga otomatis kalau seller mengisi untung %, selain itu tidak dijual.
 */
export function resolveSellPrice(
  override: { price: number; active: boolean } | undefined,
  cost: number,
  markupPct: number | null
): number | null {
  if (override) return override.active ? override.price : null;
  return markupPct === null ? null : autoSellPrice(cost, markupPct);
}
