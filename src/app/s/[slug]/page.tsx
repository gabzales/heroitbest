import type { Metadata } from "next";
import { notFound } from "next/navigation";
import StoreFront from "@/components/store/StoreFront";
import { getPublicStore } from "@/lib/data/store";
import { SLUG_RE } from "@/lib/store/common";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Toko", robots: { index: false } };

export default async function PublicStorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  const slug = raw.toLowerCase();
  if (!SLUG_RE.test(slug)) notFound();
  const store = await getPublicStore(slug);
  if (!store) notFound();
  return <StoreFront store={store} />;
}
