import PageHeader from "@/components/dashboard/PageHeader";
import DemoNote from "@/components/dashboard/seller/DemoNote";
import SellerProductEditor from "@/components/dashboard/seller/SellerProductEditor";

export default async function SellerProductEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <PageHeader title="Edit Produk" eyebrow="Jualan" back="/dashboard/seller/products" />
      <DemoNote />
      <SellerProductEditor productId={id} />
    </div>
  );
}
