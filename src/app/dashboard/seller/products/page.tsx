import PageHeader from "@/components/dashboard/PageHeader";
import DemoNote from "@/components/dashboard/seller/DemoNote";
import SellerProducts from "@/components/dashboard/seller/SellerProducts";

export default function SellerProductsPage() {
  return (
    <div>
      <PageHeader title="Produk & Stok" eyebrow="Jualan" back="/dashboard/seller" />
      <DemoNote />
      <SellerProducts />
    </div>
  );
}
