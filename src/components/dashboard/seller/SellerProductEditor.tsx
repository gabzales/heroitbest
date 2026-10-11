"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { call, rp, inputCls, btnPrimary, card } from "./api";

type Duration = {
  id: string;
  label: string;
  days: number;
  price: number;
  stock_mode: "manual" | "auto";
  provider_item_id: string | null;
  stock_count: number;
};
type Product = { id: string; name: string; category: string; active: boolean; product_durations: Duration[] };
type CatalogItem = { id: string; name: string; minSellPrice: number };

export default function SellerProductEditor({ productId }: { productId: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await call<{ product: Product }>(`/api/seller/products/${productId}`);
      setProduct(d.product);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [productId]);
  useEffect(() => {
    load();
  }, [load]);

  async function toggleActive() {
    if (!product) return;
    try {
      await call(`/api/seller/products/${productId}`, "PATCH", { active: !product.active });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !product) return <p className="text-[13px] text-danger">{error}</p>;
  if (!product) return <div className={`${card} text-[13px] text-ink-faint`}>Memuat...</div>;

  return (
    <div className="space-y-4">
      <div className={`${card} flex items-center justify-between gap-3`}>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-extrabold">{product.name}</p>
          <p className="text-[11.5px] text-ink-faint">{product.category}</p>
        </div>
        <button onClick={toggleActive} className={`rounded-full px-3 py-1.5 text-[11.5px] font-bold ${product.active ? "bg-emerald-500/15 text-emerald-500" : "bg-surface-2 text-ink-faint"}`}>
          {product.active ? "Tayang (klik untuk sembunyikan)" : "Draft (klik untuk tayangkan)"}
        </button>
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}

      {product.product_durations.map((d) => (
        <DurationCard key={d.id} productId={productId} d={d} onChanged={load} onError={setError} />
      ))}

      <AddDuration productId={productId} onAdded={load} />
    </div>
  );
}

function DurationCard({ productId, d, onChanged, onError }: { productId: string; d: Duration; onChanged: () => void; onError: (m: string | null) => void }) {
  const [price, setPrice] = useState(String(d.price));
  const [keysText, setKeysText] = useState("");
  const [keys, setKeys] = useState<{ id: string; key_string: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/seller/products/${productId}/durations/${d.id}`;

  async function savePrice() {
    setBusy(true);
    onError(null);
    try {
      await call(base, "PATCH", { price: Number(price) });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm(`Hapus durasi "${d.label}"? Stok key yang belum terjual ikut hilang.`)) return;
    try {
      await call(base, "DELETE");
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function addKeys() {
    setBusy(true);
    onError(null);
    try {
      const r = await call<{ added: number; skipped: number }>(`${base}/stock`, "POST", { keysText });
      if (r.skipped > 0) onError(`${r.added} key ditambahkan, ${r.skipped} dilewati karena sudah pernah terdaftar di sistem.`);
      setKeysText("");
      setKeys(null);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function showKeys() {
    try {
      const r = await call<{ keys: { id: string; key_string: string }[] }>(`${base}/stock`);
      setKeys(r.keys);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function deleteKey(id: string) {
    try {
      await call(`/api/seller/key-stock/${id}`, "DELETE");
      setKeys((k) => (k ? k.filter((x) => x.id !== id) : k));
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className={`${card} space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[13.5px] font-bold">{d.label}</p>
          <p className="text-[11.5px] text-ink-faint">
            {d.days} hari · {d.stock_mode === "auto" ? "Auto (stok otomatis)" : `Manual · stok ${d.stock_count}`}
          </p>
        </div>
        <button onClick={remove} aria-label="Hapus durasi" className="rounded-lg p-2 text-ink-faint hover:bg-surface-2 hover:text-danger">
          <Trash2 size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-faint">Harga</span>
        <input type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} className={`${inputCls} max-w-[160px]`} />
        <button disabled={busy || Number(price) === d.price} onClick={savePrice} className={btnPrimary}>Simpan</button>
        <span className="text-[11.5px] text-ink-faint">({rp(d.price)} sekarang)</span>
      </div>

      {d.stock_mode === "manual" && (
        <div className="space-y-2">
          <textarea
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            rows={4}
            placeholder={"Tempel key di sini, satu key per baris (maks 1000)"}
            className={`${inputCls} font-mono`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={busy || !keysText.trim()} onClick={addKeys} className={btnPrimary}>Tambah Key</button>
            <button onClick={showKeys} className="text-[12px] font-semibold text-primary hover:underline">Lihat stok tersisa</button>
          </div>
          {keys && (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface-2 p-2">
              {keys.length === 0 && <p className="text-[12px] text-ink-faint">Stok kosong.</p>}
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-2 font-mono text-[12px]">
                  <span className="truncate">{k.key_string}</span>
                  <button onClick={() => deleteKey(k.id)} aria-label="Hapus key" className="text-ink-faint hover:text-danger"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddDuration({ productId, onAdded }: { productId: string; onAdded: () => void }) {
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("1");
  const [price, setPrice] = useState("");
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [catalog, setCatalog] = useState<{ enabled: boolean; items: CatalogItem[] } | null>(null);
  const [itemId, setItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickAuto() {
    setMode("auto");
    if (catalog) return;
    try {
      setCatalog(await call<{ enabled: boolean; items: CatalogItem[] }>("/api/seller/provider-catalog"));
    } catch (e) {
      setError((e as Error).message);
      setMode("manual");
    }
  }

  const chosen = catalog?.items.find((i) => i.id === itemId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`/api/seller/products/${productId}/durations`, "POST", {
        label,
        days: Number(days),
        price: Number(price),
        stockMode: mode,
        providerItemId: mode === "auto" ? itemId : undefined,
      });
      setLabel("");
      setPrice("");
      setItemId("");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-3`}>
      <p className="text-[13px] font-bold">Tambah durasi / paket</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => setMode("manual")} className={`flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-bold ${mode === "manual" ? "border-primary bg-primary-dim text-primary" : "border-border bg-surface-2 text-ink-faint"}`}>
          Manual (key punya saya)
        </button>
        {catalog?.enabled !== false && (
          <button type="button" onClick={pickAuto} className={`flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-bold ${mode === "auto" ? "border-primary bg-primary-dim text-primary" : "border-border bg-surface-2 text-ink-faint"}`}>
            Auto (stok otomatis)
          </button>
        )}
      </div>

      {mode === "auto" && catalog && (
        <div className="space-y-2">
          <select value={itemId} onChange={(e) => {
            setItemId(e.target.value);
            const it = catalog.items.find((i) => i.id === e.target.value);
            if (it && !price) setPrice(String(it.minSellPrice));
          }} className={inputCls} required>
            <option value="">— Pilih item Auto —</option>
            {catalog.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          {chosen && <p className="text-[11.5px] text-ink-faint">Harga jual minimal untuk item ini: <b>{rp(chosen.minSellPrice)}</b>. Stok Auto tidak perlu diisi — key diambil otomatis tiap ada pembeli.</p>}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (mis. 7 HARI)" className={inputCls} />
        <input required type="number" min={0.01} step="any" value={days} onChange={(e) => setDays(e.target.value)} placeholder="Durasi (hari)" className={inputCls} />
        <input required type="number" min={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Harga jual (Rp)" className={inputCls} />
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <button disabled={busy} className={btnPrimary}>{busy ? "Menyimpan..." : "Tambah"}</button>
    </form>
  );
}
