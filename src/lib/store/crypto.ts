import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Enkripsi API key GensPay milik seller (AES-256-GCM).
 * Kunci enkripsi = env STORE_SECRET_KEY (64 karakter hex ATAU base64 dari 32 byte).
 * Bikin sekali: `openssl rand -hex 32`. JANGAN diganti setelah ada seller yang
 * menyimpan key (key lama jadi tidak bisa dibuka -- seller harus input ulang).
 *
 * Fail closed: tanpa STORE_SECRET_KEY yang valid, fitur toko seller mati
 * (tidak ada fallback menyimpan key polos).
 */
function getKey(): Buffer | null {
  const raw = (process.env.STORE_SECRET_KEY || "").trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function isStoreCryptoConfigured(): boolean {
  return getKey() !== null;
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  if (!key) throw new Error("store_crypto_not_configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(blob: string | null | undefined): string | null {
  const key = getKey();
  if (!key || !blob) return null;
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
