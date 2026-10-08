"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Copy, Check, Flag } from "lucide-react";
import { GeneratedKey } from "@/lib/types";
import { formatDateTime } from "@/lib/format";

const DISPUTE_LABEL: Record<string, string> = {
  open: "Komplain sedang diproses admin",
  resolved_refund: "Komplain disetujui — saldo dikembalikan",
  resolved_release: "Komplain ditinjau — tidak ada refund",
  dismissed: "Komplain ditolak",
};

function ReportForm({ keyId, onDone }: { keyId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/disputes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resellerKeyId: keyId, reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Gagal mengirim komplain.");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-faint hover:text-danger">
        <Flag size={13} /> Key bermasalah? Laporkan
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <textarea required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Ceritakan masalahnya (mis. key tidak valid / sudah terpakai)" className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12.5px] outline-none focus:border-primary" />
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="rounded-lg bg-danger px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-60">{busy ? "Mengirim..." : "Kirim komplain"}</button>
        <button type="button" onClick={() => setOpen(false)} className="text-[12px] font-semibold text-ink-dim">Batal</button>
      </div>
    </form>
  );
}

export default function KeyHistoryList({ keys }: { keys: GeneratedKey[] }) {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);

  function copy(id: string, value: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl2 border border-border bg-surface py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-dim text-primary">
          <KeyRound size={24} />
        </span>
        <p className="text-[13px] text-ink-faint">Belum ada key</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {keys.map((k) => (
        <div key={k.id} className="rounded-xl2 border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-bold">{k.productName}</p>
              <p className="mt-0.5 text-[11.5px] text-ink-faint">
                {k.duration} · {formatDateTime(k.createdAt)}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-primary-dim px-2.5 py-1 text-[10.5px] font-semibold text-primary">
              {k.duration}
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-lg border border-border-strong bg-surface-2 px-3.5 py-2.5">
            <span className="font-mono text-[13px] font-bold tracking-wide text-ink">
              {k.keyString}
            </span>
            <button
              onClick={() => copy(k.id, k.keyString)}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-primary"
            >
              {copied === k.id ? (
                <>
                  <Check size={13} /> Copied
                </>
              ) : (
                <>
                  <Copy size={13} /> Copy
                </>
              )}
            </button>
          </div>
          {k.disputeStatus && <p className="mt-2 text-[11.5px] font-semibold text-amber">{DISPUTE_LABEL[k.disputeStatus]}</p>}
          {k.canDispute && <ReportForm keyId={k.id} onDone={() => router.refresh()} />}
        </div>
      ))}
    </div>
  );
}
