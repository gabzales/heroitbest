"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, CheckCircle2, XCircle, PlayCircle } from "lucide-react";

type TestStep = { step: string; ok: boolean; detail: string };

const inputCls =
  "mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-primary";

export default function CheatgameSettingsForm() {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [steps, setSteps] = useState<TestStep[] | null>(null);
  const [testOk, setTestOk] = useState(false);

  function load() {
    return fetch("/api/admin/settings/cheatgame")
      .then((r) => r.json())
      .then((d) => {
        setBaseUrl(d.baseUrl);
        setApiKeyMasked(d.apiKeyMasked);
        setConfigured(d.configured);
      });
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setSteps(null);
    const res = await fetch("/api/admin/settings/cheatgame", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMessage("Tersimpan.");
      setApiKey("");
      await load();
    } else {
      setMessage(data.message || "Gagal menyimpan.");
    }
  }

  async function runTest() {
    setTesting(true);
    setSteps(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings/cheatgame", { method: "POST" });
      const data = await res.json();
      setSteps(data.steps ?? [{ step: "test", ok: false, detail: data.message || "Test gagal." }]);
      setTestOk(Boolean(data.ok));
    } catch {
      setSteps([{ step: "network", ok: false, detail: "Tidak bisa memanggil endpoint test." }]);
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  if (loading) return null;

  return (
    <form onSubmit={save} className="mt-4 rounded-xl2 border border-border bg-surface p-5">
      <p className="text-[13.5px] font-bold">Supplier kedua: CHEATGAME.ONLINE (CGS)</p>
      <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-dim px-3 py-2.5">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber" />
        <p className="text-[11.5px] text-ink-dim">
          Dengan ini heroitbest bisa mengambil key dari akun reseller cheatgame.online. API Key BOLEH sama dengan yang
          dipakai di heromarket. Di Edit Produk → Mapping Provider, pilih sumber <b>CHEATGAME (CGS)</b> untuk varian yang
          mau diambil dari sana. Saldo yang terpotong adalah saldo akun reseller itu (dalam USD).
        </p>
      </div>
      <div className="mt-4 space-y-3">
        <label className="block text-[11px] font-semibold text-ink-faint">
          Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={inputCls} />
        </label>
        <label className="block text-[11px] font-semibold text-ink-faint">
          API Key {apiKeyMasked && <span>(saat ini: {apiKeyMasked})</span>}
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={apiKeyMasked ? "Kosongkan kalau tidak diganti" : "Isi API Key (X-API-Key) CHEATGAME"}
            className={`${inputCls} font-mono`}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-60">
          {busy ? "Menyimpan..." : "Simpan"}
        </button>
        <button
          type="button"
          onClick={runTest}
          disabled={testing || !configured}
          className="flex items-center gap-1.5 rounded-lg bg-teal px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-60"
        >
          <PlayCircle size={14} /> {testing ? "Menguji..." : "Test Koneksi"}
        </button>
        <span className={`text-[11.5px] font-semibold ${configured ? "text-teal" : "text-danger"}`}>
          {configured ? "API Key terisi" : "Belum dikonfigurasi"}
        </span>
        {message && <span className="text-[11.5px] text-ink-faint">{message}</span>}
      </div>
      {steps && (
        <ol className="mt-3 space-y-1.5">
          <li className="flex items-center gap-2 text-[12.5px] font-bold">
            {testOk ? <CheckCircle2 size={15} className="text-teal" /> : <XCircle size={15} className="text-danger" />}
            {testOk ? "Koneksi CHEATGAME OK" : "Ada masalah di koneksi CHEATGAME"}
          </li>
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              {s.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-teal" /> : <XCircle size={13} className="mt-0.5 shrink-0 text-danger" />}
              <span>
                <span className="font-mono font-semibold text-ink-faint">{s.step}</span> <span className="text-ink-dim">— {s.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </form>
  );
}
