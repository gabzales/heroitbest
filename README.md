# heroitbest — Marketplace Reseller

Marketplace key digital: pembeli beli key dari katalog gabungan (stok platform + stok tiap seller),
seller bebas daftar dan jualan sendiri. Dibangun dengan Next.js 14 + Supabase,
domain `heroitbest.com`. Web ini **terpisah** dari toko HeroMarket.

## Model bisnis (sudah disepakati)
- **Escrow**: pembeli bayar ke payment gateway **platform** (GensPay / stenly.id). Penghasilan seller
  hanya angka di sistem sampai dia ajukan penarikan; admin transfer **manual** lalu tandai "dibayar".
- **Self-register**: user yang sudah login bisa daftar jadi seller di `/dashboard/seller` dan langsung jualan.
- **Listing terpisah per seller** (bukan digabung seperti buy-box).
- **Dua mode stok** per paket:
  - *Manual* — seller tempel key miliknya sendiri (`key_stock` per seller, key unik global).
  - *Auto* — key diambil live dari supplier vipbestmods memakai **satu akun milik platform**. Harga jual
    wajib ≥ harga modal × (1 + margin minimum). Setiap penjualan memotong saldo supplier **platform**.
- **Saldo seller** dihitung dari `reseller_keys` (bukan counter): *ditahan* sampai masa tahan lewat
  (default 48 jam) atau ada komplain terbuka, lalu *bisa ditarik*. Tidak butuh cron.
- **Komplain**: pembeli bisa lapor selama masa tahan. Admin putuskan: refund pembeli / lepas ke seller / tolak.

## Setup (urut)
1. **Database** — buat project Supabase BARU, buka SQL Editor, tempel isi **satu file**
   `supabase/setup.sql`, klik Run (sekali saja). Itu semua: tabel, RLS, top-up aman, marketplace, lock-down RPC.
2. **Env di Vercel** (lihat `.env.example`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL=https://heroitbest.com`, `NEXT_PUBLIC_ADMIN_WHATSAPP_NUMBER`.
3. **Deploy** ke Vercel, pasang domain.
4. **Buat admin pertama** (pilih salah satu):
   - **Lewat web**: isi env `SETUP_ADMIN_SECRET` (string rahasia bebas) di Vercel, redeploy, buka
     `https://heroitbest.com/setup-admin`, isi kode rahasia + email + password. Hanya jalan selama belum ada admin;
     setelah selesai kosongkan `SETUP_ADMIN_SECRET`.
   - **Lewat terminal**: `npm i && node scripts/create-admin.js email@kamu.com "password-kuat" "Nama Admin"`
     (butuh `.env.local` berisi URL + service-role key; juga dipakai untuk reset password admin).
   Lalu login di `/login`.
5. **Panel admin**:
   - **GensPay / stenly.id** → kredensial + daftarkan callback: `https://heroitbest.com/api/webhooks/topup`
     (GensPay) dan `https://heroitbest.com/api/webhooks/stenly` (stenly.id; project's Callback URL di dashboard mereka).
   - **Reseller API** → kredensial vipbestmods (hanya kalau mengizinkan listing Auto).
   - **Pengaturan Marketplace** → komisi default (10%), masa tahan (48 jam), margin minimum Auto (20%).

## Keamanan & alur uang (ringkas)
- Semua fungsi database sensitif hanya bisa dipanggil server (service-role); browser/anon tidak bisa `rpc`.
- Top-up: baris `pending` dibuat sebelum gateway dipanggil; webhook EXPIRED/FAILED menutup baris; pending >30 menit
  otomatis `expired`; bayar telat tetap dikreditkan; stenly.id dicek ulang ke gateway karena tidak retry webhook.
- Pembelian Auto dikunci per akun; seller tidak bisa beli dari tokonya sendiri.
- Tidak ada endpoint debug. `/setup-admin` terkunci kode rahasia, rate-limit, dan mati otomatis setelah admin pertama ada. Rahasia (service-role, kunci gateway) tidak pernah dikirim ke browser.
- Log lama (`rate_limit_hits`, `webhook_log`, `provider_error_log`) dibersihkan otomatis (hemat kuota Supabase gratis).
- Tidak dijaga sistem: cuci saldo lewat 2 akun (top-up bonus → beli ke toko akun kedua). Cek manual withdrawal
  seller yang pembelinya baru top-up.

## Peta fitur
| Siapa | Halaman |
|---|---|
| Seller | `/dashboard/seller` (toko, saldo), `/products` (listing + stok), `/sales`, `/withdraw` |
| Pembeli | `/dashboard/generate` (katalog + badge toko), `/dashboard/history/keys` (tombol "Laporkan") |
| Admin | `/dashboard/admin/sellers`, `/withdrawals`, `/disputes`, `/settings/marketplace` |

## Hal yang perlu dipantau owner
- **Saldo supplier vipbestmods**: listing Auto milik semua seller memakai saldo itu. Kalau habis, semua
  penjualan Auto gagal. Pantau di *Debug Provider*.
- **Margin Auto** hanya dicek saat listing dibuat/diedit; kalau harga supplier naik belakangan, margin bisa
  menipis sampai harga diperbarui (kolom `reseller_keys.provider_cost` mencatat ongkos real per penjualan).
- **Refund listing Auto**: ongkos supplier yang sudah dibayar platform tidak kembali.
- **Refund setelah seller menarik uang**: pendapatan itu otomatis terpotong dari penjualan berikutnya seller
  (`available = earned − reserved − paid`), tapi kalau seller berhenti jualan, selisihnya tidak bisa ditagih sistem.

## API partner
Dokumentasi di `/docs/api-v1` (server-to-server, `X-API-Key`; kunci diatur di Admin → Partner API).


## Cloudflare Turnstile (anti-bot)

1. Buat widget di dash.cloudflare.com -> Turnstile (domain: domain situsmu).
2. Vercel env: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (site key, publik) dan `TURNSTILE_SECRET_KEY` (secret, rahasia). Redeploy.
3. Supabase -> Authentication -> Attack Protection -> aktifkan CAPTCHA -> Turnstile -> tempel secret key yang sama. (Login diverifikasi oleh Supabase.)
4. `/setup-admin` diverifikasi oleh server lewat `TURNSTILE_SECRET_KEY`.

Urutan penting: isi env + redeploy DULU, baru aktifkan CAPTCHA di Supabase. Kalau CAPTCHA Supabase aktif tapi site key belum diisi, login akan ditolak.
