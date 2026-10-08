import { demoGet } from "./demo-data";

// MODE DEMO: env Supabase belum diisi -> halaman seller tampil dengan data
// contoh (read-only) supaya tampilannya bisa dilihat sebelum backend terhubung.
export const IS_DEMO = !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export async function call<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown): Promise<T> {
  if (IS_DEMO) {
    if (method !== "GET") throw new Error("Mode demo: backend belum terhubung — aksi ini aktif setelah Supabase dihubungkan.");
    const sample = demoGet(url);
    if (sample === undefined) throw new Error("Mode demo: data contoh untuk bagian ini belum tersedia.");
    return sample as T;
  }
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message || "Terjadi kesalahan.");
  return data as T;
}

export const rp = (n: number) => "Rp" + n.toLocaleString("id-ID");

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const inputCls =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-primary";
export const btnPrimary =
  "rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60";
export const card = "rounded-xl2 border border-border bg-surface p-4";
