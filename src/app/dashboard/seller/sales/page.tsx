import PageHeader from "@/components/dashboard/PageHeader";
import DemoNote from "@/components/dashboard/seller/DemoNote";
import SellerSales from "@/components/dashboard/seller/SellerSales";

export default function SellerSalesPage() {
  return (
    <div>
      <PageHeader title="Penjualan" eyebrow="Jualan" back="/dashboard/seller" />
      <DemoNote />
      <SellerSales />
    </div>
  );
}
