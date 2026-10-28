"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, CheckCircle2, XCircle, PlayCircle } from "lucide-react";

type ActiveGateway = "genspay" | "pakasir" | "wijayapay";
type TestStep = { step: string; ok: boolean; detail: string };
type TestResult = { ok: boolean; steps: TestStep[]; elapsedMs?: number };

const inputCls =
  "mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-primary";

const GATEWAY_LABEL: Record<ActiveGateway, string> = { genspay: "GensPay", pakasir: "Pakasir", wijayapay: "WijayaPay" };

export default function WijayapaySettingsForm() {
  const [baseUrl, setBaseUrl] = useState("");
  const [merchantCodeMasked, setMerchantCodeMasked] = useState("");
  const [merchantCode, setMerchantCode] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [activeGateway, setActiveGateway] = useState<ActiveGateway>("genspay");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [origin, setOrigin] = useState("");

  function load() {
    return fetch("/api/admin/settings/wijayapay")
      .then((r) => r.json())
      .then((data) => {
        setBaseUrl(data.baseUrl);
        setMerchantCodeMasked(data.merchantCodeMasked);
        setApiKeyMasked(data.apiKeyMasked);
        setConfigured(data.configured);
        setActiveGateway(data.activeGateway);
      });
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    load().finally(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setTestResult(null);
    const res = await fetch("/api/admin/settings/wijayapay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, merchantCode, apiKey }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      setMessage("Kredensial tersimpan.");
      setMerchantCode("");
      setApiKey("");
      await load();
    } else {
      setMessage(data.message || "Gagal menyimpan.");
    }
  }

  async function switchGateway(gw: ActiveGateway) {
    if (gw === activeGateway) return;
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/admin/settings/wijayapay", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeGateway: gw }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setActiveGateway(gw);
      setMessage(`Gateway aktif sekarang: ${GATEWAY_LABEL[gw]}.`);
    } else {
      setMessage(data.message || "Gagal ganti gateway aktif.");
    }
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings/wijayapay/test", { method: "POST" });
      setTestResult((await res.json()) as TestResult);
    } catch {
      setTestResult({ ok: false, steps: [{ step: "network", ok: false, detail: "Tidak bisa memanggil endpoint test." }] });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl2 border border-border bg-surface p-5 text-[13px] text-ink-faint">Memuat...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl2 border border-border bg-surface p-5">
        <p className="mb-3 text-[13px] font-bold">Gateway Pembayaran Aktif</p>
        <div className="flex gap-2">
          {(["genspay", "pakasir", "wijayapay"] as ActiveGateway[]).map((gw) => (
            <button
              key={gw}
              type="button"
              onClick={() => switchGateway(gw)}
              disabled={busy}
              className={`flex-1 rounded-lg border px-4 py-2.5 text-[12.5px] font-bold transition-colors ${
                activeGateway === gw ? "border-primary bg-primary-dim text-primary" : "border-border bg-surface-2 text-ink-faint"
              }`}
            >
              {GATEWAY_LABEL[gw]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          Hanya satu gateway yang aktif untuk top up saldo. Isi dan test kredensial WijayaPay dulu sebelum mengaktifkannya.
        </p>
      </div>

      <form onSubmit={save} className="rounded-xl2 border border-border bg-surface p-5">
        <div className="flex items-start gap-2 rounded-lg bg-amber-dim px-3 py-2.5">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber" />
          <p className="text-[11.5px] text-ink-dim">
            Merchant Code dan API Key ada di dashboard merchant WijayaPay. Pembayaran lewat <b>QRIS</b>; biaya channel mengikuti
            akun WijayaPay (kalau ditanggung pembeli, nominal bayar otomatis ditambah fee dan saldo tetap masuk sesuai paket).
            Kalau test gagal karena IP, minta CS WijayaPay menghapus whitelist IP.
          </p>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-[11px] font-semibold text-ink-faint">
            Base URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://gateway.wijayapay.com" className={inputCls} />
          </label>
          <label className="block text-[11px] font-semibold text-ink-faint">
            Merchant Code {merchantCodeMasked && <span className="text-ink-faint">(saat ini: {merchantCodeMasked})</span>}
            <input
              value={merchantCode}
              onChange={(e) => setMerchantCode(e.target.value)}
              placeholder={merchantCodeMasked ? "Kosongkan kalau tidak diganti" : "Code Merchant dari dashboard WijayaPay"}
              className={`${inputCls} font-mono`}
            />
          </label>
          <label className="block text-[11px] font-semibold text-ink-faint">
            API Key {apiKeyMasked && <span className="text-ink-faint">(saat ini: {apiKeyMasked})</span>}
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiKeyMasked ? "Kosongkan kalau tidak diganti" : "API Key dari dashboard WijayaPay"}
              className={`${inputCls} font-mono`}
            />
          </label>
        </div>

        <div className="mt-4 rounded-lg bg-surface-2 p-3">
          <p className="text-[11.5px] font-bold text-ink-dim">Webhook (Callback) URL untuk diisi di WijayaPay</p>
          <code className="mt-1.5 block break-all rounded-md bg-surface px-2.5 py-2 font-mono text-[11.5px]">
            {(origin || "https://domain-kamu") + "/api/webhooks/wijayapay"}
          </code>
          <p className="mt-1.5 text-[11px] text-ink-faint">
            Webhook diverifikasi lewat header <b>X-Signature</b> (md5) dan dikonfirmasi ulang ke API status. IP pengirim WijayaPay:{" "}
            <span className="font-mono">172.235.245.77</span>.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-60">
            {busy ? "Menyimpan..." : "Simpan"}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="flex items-center gap-1.5 rounded-lg bg-teal px-4 py-2 text-[12.5px] font-bold text-white disabled:opacity-60"
          >
            <PlayCircle size={14} /> {testing ? "Menguji..." : "Test & Debug"}
          </button>
          <span className={`text-[11.5px] font-semibold ${configured ? "text-teal" : "text-danger"}`}>
            {configured ? "Terhubung" : "Belum dikonfigurasi"}
          </span>
          {message && <span className="text-[11.5px] text-ink-faint">{message}</span>}
        </div>
      </form>

      {testResult && (
        <div className="rounded-xl2 border border-border bg-surface p-5">
          <div className="flex items-center gap-2">
            {testResult.ok ? <CheckCircle2 size={16} className="text-teal" /> : <XCircle size={16} className="text-danger" />}
            <p className="text-[13px] font-bold">{testResult.ok ? "Koneksi WijayaPay OK" : "Ada masalah di koneksi WijayaPay"}</p>
            {typeof testResult.elapsedMs === "number" && <span className="text-[11.5px] text-ink-faint">{testResult.elapsedMs}ms</span>}
          </div>
          <ol className="mt-3 space-y-2">
            {testResult.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px]">
                {s.ok ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-teal" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />
                )}
                <span>
                  <span className="font-mono font-semibold text-ink-faint">{s.step}</span>{" "}
                  <span className="text-ink-dim">— {s.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-ink-faint">
            Test membuat tagihan QRIS uji Rp1.000 lalu mengecek statusnya. Tagihan tidak perlu dibayar dan kedaluwarsa sendiri.
          </p>
        </div>
      )}
    </div>
  );
}
