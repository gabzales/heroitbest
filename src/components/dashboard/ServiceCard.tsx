import Link from "next/link";
import { LucideIcon, ArrowUpRight } from "lucide-react";

// Kartu layanan gaya vipbestmods: kartu gelap polos, hanya ikonnya yang diwarnai
// (tone -> CSS var tema aktif).
const TONE_VARS = {
  primary: "var(--primary)",
  rose: "var(--rose)",
  teal: "var(--teal)",
  amber: "var(--amber)",
} as const;

export default function ServiceCard({
  href,
  title,
  subtitle,
  icon: Icon,
  tone,
}: {
  href: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  tone: keyof typeof TONE_VARS;
}) {
  const c = TONE_VARS[tone];
  return (
    <Link
      href={href}
      className="group relative flex min-h-[116px] flex-col justify-between overflow-hidden rounded-xl2 border border-border bg-surface p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40"
    >
      <div className="flex items-start justify-between">
        <span
          className="flex h-10 w-10 items-center justify-center rounded-xl"
          style={{ color: c, backgroundColor: `color-mix(in srgb, ${c} 16%, transparent)` }}
        >
          <Icon size={19} strokeWidth={2.1} />
        </span>
        <ArrowUpRight size={16} className="text-ink-faint opacity-0 transition-opacity group-hover:opacity-90" />
      </div>
      <div>
        <p className="text-[12.5px] font-extrabold uppercase leading-tight tracking-wide">{title}</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">{subtitle}</p>
      </div>
    </Link>
  );
}
