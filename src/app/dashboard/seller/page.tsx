import { redirect } from "next/navigation";

// Menu "Jualan" (pendaftaran seller marketplace) diganti etalase produk.
// Link lama diarahkan ke etalase supaya tidak 404.
export default function SellerHomePage() {
  redirect("/dashboard/generate");
}
