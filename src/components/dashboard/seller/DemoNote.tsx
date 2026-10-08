import { isSupabaseConfigured } from "@/lib/supabase/config";

export default function DemoNote() {
  if (isSupabaseConfigured) return null;
  return (
    <div className="mb-4 rounded-xl2 border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[12.5px] text-ink-dim">
      <b className="text-ink">Mode demo</b> — backend (Supabase) belum terhubung. Data di halaman ini hanya contoh dan tombol aksi dinonaktifkan sampai env diisi.
    </div>
  );
}
