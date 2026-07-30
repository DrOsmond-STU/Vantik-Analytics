# Memasang Vantik Analytics di Shared Hosting

Panduan ini untuk shared hosting **cPanel/CloudLinux** dengan fitur *Setup Node.js App*
(Phusion Passenger) — bentuk yang paling umum di Indonesia. Untuk VPS/on-premise, lihat
`infra/Dockerfile` dan `infra/k8s/` yang mengikuti DEPLOYMENT.md.

---

## 0. Prasyarat — periksa dulu sebelum membeli/melanjutkan

Vantik Analytics adalah aplikasi **Node.js**, bukan PHP. Hosting Anda **wajib** punya:

| Kebutuhan | Cara memeriksa | Bila tidak ada |
|---|---|---|
| Node.js ≥ 20 (disarankan ≥ 22) | cPanel → **Setup Node.js App** ada di menu | Aplikasi tidak dapat berjalan. Perlu hosting Node atau VPS. |
| Akses SSH atau Terminal cPanel | cPanel → **Terminal** | Masih bisa, tetapi seeding awal harus lewat cPanel "Run NPM Script". |
| Izin tulis di luar `public_html` | File Manager → buat folder di `~/` | Basis data harus ditaruh di luar document root. Tanpa itu, jangan lanjut. |

> **Catatan penting soal Node ≥ 22.5:** aplikasi ini dapat berjalan **tanpa modul native
> sama sekali** karena memakai `node:sqlite` bawaan Node. Pada Node 20, `node:sqlite`
> belum ada sehingga `better-sqlite3` harus berhasil terpasang. Jadi **Node 22 sangat
> disarankan** — itu menghilangkan satu-satunya titik gagal instalasi yang lazim.

Basis data yang dipakai adalah **SQLite** (berkas), bukan MySQL. Tidak perlu membuat
database di cPanel.

---

## 1. Build paket di komputer lokal

Shared hosting biasanya tidak mampu menjalankan `tsc`/`vite` (batas memori, dan
`devDependencies` tidak terpasang). Karena itu kompilasi dilakukan di lokal:

```bash
git clone <repo> && cd vantik-analytics
npm install
npm run build          # typecheck + kompilasi server + build frontend
npm run package        # menghasilkan folder ./deploy
```

Hasilnya folder `deploy/` berisi:

```
app.js          berkas startup Passenger
load-env.js     pemuat .env tanpa dependensi
package.json    dependensi runtime saja
.htaccess       proteksi berkas aplikasi
.env.example    contoh konfigurasi
server/         JavaScript hasil kompilasi (bukan TypeScript)
public/         frontend hasil build
```

---

## 2. Unggah

1. Kompres `deploy/` menjadi `deploy.zip`.
2. cPanel → **File Manager** → masuk ke home directory (`~`), **bukan** `public_html`.
3. Buat folder `vantik`, unggah `deploy.zip` ke dalamnya, lalu **Extract**.
4. Buat folder data **satu tingkat di atas** aplikasi, sejajar dengan `vantik`:

```
~/vantik/          ← direktori aplikasi (isi deploy/)
~/vantik-data/     ← basis data; buat manual, biarkan kosong
```

> Menaruh basis data di luar direktori aplikasi bukan sekadar kerapian: berkas `.db`
> yang bisa diunduh lewat HTTP berarti seluruh isinya bocor — termasuk Log Aktivitas
> dan hash kata sandi (SECURITY.md Bagian 6 & 9). `.htaccess` yang disertakan sudah
> menolak akses tersebut, tetapi menaruhnya di luar document root adalah lapisan
> pertahanan yang tidak bergantung pada konfigurasi Apache.

---

## 3. Buat aplikasi Node di cPanel

cPanel → **Setup Node.js App** → **Create Application**:

| Kolom | Nilai |
|---|---|
| Node.js version | 22.x (atau tertinggi yang tersedia) |
| Application mode | **Production** |
| Application root | `vantik` |
| Application URL | domain/subdomain tujuan, mis. `analitik.domain-anda.id` |
| Application startup file | `app.js` |

Klik **Create**. Jangan jalankan dulu.

---

## 4. Konfigurasi variabel lingkungan

Bangkitkan kunci enkripsi di **Terminal**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lalu di **Setup Node.js App**, bagian *Environment variables*, tambahkan:

| Nama | Nilai |
|---|---|
| `NODE_ENV` | `production` |
| `VANTIK_MASTER_KEY` | hasil perintah di atas (64 karakter hex) |
| `VANTIK_DATA_DIR` | `../vantik-data` |

Alternatif: salin `.env.example` menjadi `.env` di `~/vantik/` dan isi di sana.
Variabel dari panel hosting **menang** atas berkas `.env`.

> **Simpan `VANTIK_MASTER_KEY` di tempat aman.** Kunci ini mengenkripsi kredensial
> Koneksi Eksternal. Bila hilang, kredensial tersimpan tidak dapat didekripsi lagi dan
> harus dimasukkan ulang. Aplikasi **menolak berjalan** di production tanpa kunci ini —
> itu disengaja, agar tidak ada instalasi yang berjalan dengan kunci lemah.

---

## 5. Pasang dependensi

**Setup Node.js App** → **Run NPM Install**.

Atau lewat Terminal (ganti path virtualenv sesuai yang ditampilkan cPanel):

```bash
source ~/nodevenv/vantik/22/bin/activate
cd ~/vantik
npm install --omit=dev
```

### Bila `better-sqlite3` gagal terpasang

**Itu tidak masalah dan tidak perlu diperbaiki.** Paket ini terdaftar sebagai
`optionalDependencies`, jadi `npm install` tetap berhasil. Aplikasi otomatis memakai
`node:sqlite` bawaan Node. Anda akan melihat pesan seperti:

```
npm warn optional dep failed, continuing better-sqlite3@11.x
```

Verifikasi driver mana yang terpakai lewat log startup (langkah 7).

Bila Node Anda **20.x** dan `better-sqlite3` gagal, aplikasi tidak akan bisa membuka
basis data. Naikkan versi Node ke 22 di dropdown cPanel, lalu `npm install` ulang.

---

## 6. Isi data awal (opsional, untuk mencoba)

```bash
cd ~/vantik && npm run seed
```

Membuat tenant demo `demo` dengan pengguna `admin@demo.vantik.id` / `VantikDemo#2026`.

> **Jangan jalankan seed pada instalasi yang akan dipakai sungguhan.** Data ini
> sintetis dan kata sandinya publik. Untuk instalasi nyata, lewati langkah ini dan
> buat tenant pertama lewat Terminal:
>
> ```bash
> cd ~/vantik && node -e "
> const { createApp } = require('./server/app.js');
> const { tenants, db } = createApp();
> const r = tenants.provision({
>   name: 'Nama Organisasi', slug: 'organisasi', planCode: 'enterprise',
>   billingCycle: 'annual', trialDays: 30,
>   admin: { fullName: 'Nama Admin', nik: 'NIK-001',
>            email: 'admin@domain-anda.id', password: 'GantiKataSandiIni#2026' },
> }, 'setup');
> console.log('tenant dibuat:', r.tenantId); db.close();
> "
> ```
>
> Kata sandi harus ≥ 12 karakter dengan huruf, angka, dan simbol (SECURITY.md Bagian 4).

---

## 7. Jalankan dan verifikasi

**Setup Node.js App** → **Restart**. Lalu:

```bash
curl -sS https://analitik.domain-anda.id/healthz
# {"status":"ok","service":"vantik-analytics"}
```

Periksa log startup (cPanel → **Errors**, atau berkas `stderr.log` di direktori
aplikasi). Baris yang dicari:

```
[vantik] siap · port 30123 · driver node:sqlite · data /home/user/vantik-data
```

`driver` memberi tahu SQLite mana yang terpakai — berguna bila ada masalah performa.

Buka URL aplikasi di browser dan masuk.

---

## 8. Daftar periksa pasca-pasang

Mengikuti DEPLOYMENT.md Bagian 10 (checklist pra-peluncuran R1) dan SECURITY.md:

- [ ] `https://.../healthz` mengembalikan `ok`
- [ ] Login berhasil dan dashboard tampil
- [ ] `https://.../server/app.js` mengembalikan **404/403** — bukan isi berkas
- [ ] `https://.../.env` mengembalikan **404/403**
- [ ] Berkas `.db` **tidak** ada di dalam `public_html`
- [ ] `NODE_ENV=production` aktif (cookie sesi ber-flag `Secure`)
- [ ] Situs dipaksa HTTPS (`.htaccess` sudah mengaturnya; pastikan sertifikat aktif)
- [ ] Kata sandi admin default sudah diganti lewat **Perangkat & Sesi → Kata Sandi**; seed demo tidak dijalankan di production
- [ ] `VANTIK_MASTER_KEY` tercatat di pengelola kata sandi organisasi
- [ ] **Verifikasi dua langkah admin sudah diaktifkan** (lihat 8.1 — wajib sebelum admin dapat bekerja)
- [ ] **Kode pemulihan admin sudah dicetak/disimpan di luar sistem**
- [ ] Backup `~/vantik-data/` masuk jadwal backup hosting
- [ ] **Cron penjadwal terpasang** bila hosting mendukungnya (lihat 8.2) — tanpa itu,
      notifikasi ambang batas hanya dievaluasi selama ada proses yang hidup, faktur
      perpanjangan tertunda, dan pesan yang gagal terkirim menunggu sampai ada orang membuka
      aplikasi (blokir masa berlaku sendiri tetap berjalan — lihat 8.1d)
- [ ] Jangka waktu berlangganan tenant sudah sesuai kontrak (lihat 8.1d) dan tanggal
      berakhirnya tercatat di luar sistem
- [ ] **Ada pemegang peran Platform Operator** (lihat 8.1f) — tanpa `billing:settle`, tidak
      ada seorang pun yang dapat mencatat pembayaran, dan pelanggan yang sudah transfer
      tetap terkunci
- [ ] `VANTIK_PAYMENT_WEBHOOK_SECRET` diisi bila memakai payment gateway; dibiarkan kosong
      berarti webhook-nya MENOLAK semua pemberitahuan (fail secure)
- [ ] Bila memakai Xendit/Midtrans (lihat 8.1g): kredensial diisi, **URL kabar pembayaran
      terdaftar di dasbor penyedia**, dan satu pembayaran uji sudah membuka ruang kerja
      secara otomatis
- [ ] Jendela pemangkasan tabel ditinjau bila pemakaian berat (lihat 8.4); pertumbuhan
      berkas audit dipahami tidak dapat dipangkas (lihat 9b)
- [ ] Kredensial notifikasi diisi (lihat 8.3) — SMTP minimal, karena tanpanya OTP pemindahan
      perangkat dan kode pemulihan kata sandi harus disampaikan manual oleh Admin
- [ ] Setelah diisi: satu notifikasi uji berstatus `sent` di
      `GET /api/v1/notifications/outbox`, dan kanal yang diharapkan muncul di
      `GET /api/v1/system/notification-channels`

### 8.1 Aktifkan verifikasi dua langkah SEBELUM hal lain

Lima peran mewajibkan MFA: **Super Admin, Platform Operator, System Admin, Data Engineer,
dan Data Steward** (`mfaRequired` di `services/src/platform/rbac.ts`). Pemegang peran itu
**dapat masuk** tetapi **tidak dapat melakukan apa pun** sebelum MFA diaktifkan — setiap
permintaan yang memakai izin dibalas `403 error.mfa_enrolment_required`. Itu memang
disengaja, bukan kerusakan: memberi akses penuh kepada Super Admin hanya dengan kata sandi
adalah risiko yang tidak sebanding.

Langkahnya, tepat setelah login pertama:

1. Buka **Perangkat & Sesi** → panel **Verifikasi Dua Langkah** → *Aktifkan*.
2. Tambahkan rahasia yang muncul ke aplikasi autentikator (Google Authenticator, Aegis,
   1Password, Bitwarden — apa pun yang mendukung TOTP standar). Entri manual selalu
   tersedia; URI `otpauth://` disediakan bagi yang ingin menempelkannya.
3. Masukkan kode 6 digit → *Aktifkan*.
4. **Simpan sepuluh kode pemulihan yang muncul.** Kode itu ditampilkan **sekali** dan
   setelahnya hanya hash-nya yang tersimpan — tidak ada seorang pun, termasuk operator
   platform, yang dapat menampilkannya kembali. Cetak dan simpan di luar sistem.

> **Peringatan yang perlu dibaca sebelum, bukan sesudah:** bila autentikator DAN seluruh
> kode pemulihan hilang, akun itu tidak dapat dipulihkan dari dalam aplikasi. Pada tenant
> yang hanya punya satu Super Admin, itu berarti tenant tanpa administrator. Karena itu:
> sediakan **dua** akun Super Admin dengan autentikator berbeda, atau simpan kode
> pemulihan di tempat yang benar-benar terpisah dari perangkat.

Yang perlu diketahui operator:

- Kode berlaku 30 detik, dengan toleransi jam ±30 detik. Bila kode selalu ditolak,
  periksa jam perangkat pengguna — bukan jam server.
- Satu kode tidak dapat dipakai dua kali. Login kedua dalam jendela 30 detik yang sama
  akan ditolak; tunggu kode berikutnya.
- Lima kali salah pada satu sesi verifikasi mematikan sesi itu (harus login ulang);
  sepuluh kegagalan berturut-turut mengunci akun sementara.
- Peran yang mewajibkan MFA **tidak dapat** mematikannya sendiri.

### 8.1b Kata sandi: siapa dapat mengganti apa

- **Akun sendiri** — **Perangkat & Sesi → Kata Sandi**. Kata sandi lama wajib diisi; sesi
  yang sah saja tidak cukup. Itu disengaja: sesi yang dicuri tidak boleh dapat merebut akun
  secara permanen, ia hanya boleh memakai akses yang terlanjur dimilikinya.
- **Akun orang lain** — Admin memakai `POST /api/v1/authorization/users/:id/password`
  (izin `authorization:write`, dan re-autentikasi dalam 5 menit terakhir). Reset ini
  **mencabut seluruh sesi target**, karena reset justru dipakai ketika kata sandi lama
  diduga bocor.
- Kebijakan yang sama berlaku pada kedua jalur: minimal 12 karakter dengan huruf, angka,
  dan simbol, serta penolakan kata sandi yang pernah dipakai. Reset oleh admin bukan pintu
  belakang untuk memasang kata sandi lemah.

- **Lupa kata sandi** — tautan **Lupa kata sandi?** di halaman masuk. Pengguna memasukkan
  alamat emailnya; bila akunnya ada, kode pemulihan berumur 30 menit dibuat dan masuk
  antrean notifikasi. Jawaban layar SAMA untuk alamat terdaftar dan tidak terdaftar —
  formulir yang membedakan keduanya adalah alat pemetaan gratis bagi penebak.

> **Selama kredensial SMTP belum diisi (lihat 8.3), kode pemulihan menunggu di antrean.**
> Admin membacanya dari `GET /api/v1/notifications/outbox` dan menyampaikannya lewat kanal
> terpercaya. Begitu SMTP diisi, jalur yang sama berjalan otomatis tanpa perubahan kode.
> Sampai saat itu, **sediakan dua akun Admin** — kalau tidak, Admin yang lupa kata sandinya
> sendiri tidak punya siapa pun yang dapat membacakan kodenya.

### 8.1c Pendaftaran mandiri: buka atau tutup

Halaman depan menawarkan paket berlangganan, dan pengunjung dapat mendaftar sendiri.
Pendaftarannya menunggu persetujuan admin, dan ruang kerjanya belum dapat menulis sampai
pembayaran pertama tercatat — tidak ada masa pakai gratis (lihat 8.1e). Setiap pendaftaran
yang berhasil tetap **membuat tenant**, jadi jalurnya dibatasi 3 per jam per alamat IP — di
shared hosting dengan satu berkas SQLite dan kuota disk, batas itu bukan formalitas.

Untuk pemasangan internal yang penggunanya dibuat administrator, matikan:

```
VANTIK_SELF_SIGNUP=off
```

Halaman depan ikut menyembunyikan ajakan mendaftar bila dimatikan, sehingga tidak ada
tombol yang mengarah ke penolakan.

**Pendaftaran mandiri SELALU menunggu persetujuan.** Pendaftar belum diverifikasi siapa
pun, jadi ruang kerjanya dibuat berstatus `pending` dan **tidak dapat dimasuki** sampai
seseorang memutuskannya:

1. Pendaftar menerima layar "menunggu persetujuan" — bukan tombol Masuk yang pasti gagal.
2. Setiap pemegang peran **Platform Operator** menerima pemberitahuan di antrean
   notifikasi (lihat 8.3 — bila kanalnya belum diisi, pesannya menunggu di antrean).
3. Operator membuka **Manajemen Tenant → Pendaftaran menunggu persetujuan**, lalu
   menyetujui atau menolak. Penolakan **wajib** menyertakan alasan, dan alasan itu
   dikirimkan ke pendaftar.

Yang perlu Anda siapkan: **minimal satu akun berperan Platform Operator.** Tanpa itu
antrean tidak punya pemilik dan tidak ada yang menerima kabar pendaftaran baru — akun
`super_admin` tetap dapat memutuskan (perannya `*:*`), tetapi ia tidak akan diberi tahu.
Data seed menyediakan satu contoh (`operator@vantik.id`).

Menolak **tidak menghapus apa pun**: tenant, pengguna, dan langganannya tetap tersimpan
sampai retensi berjalan, sehingga keputusan dapat ditinjau ulang. Keputusan hanya berlaku
sekali — menyetujui tenant yang sudah aktif ditolak dengan `error.registration_already_decided`.

### 8.1d Masa berlaku langganan: 1, 3, 6, atau 12 bulan

Pengunjung memilih jangka waktunya sendiri saat berlangganan — 1 bulan, 3 bulan, 6 bulan,
atau 12 bulan. Semakin panjang jangka waktunya, semakin murah biaya per bulannya; angka
diskonnya ada di `BILLING_CYCLES` (`services/src/platform/featureFlags.ts`) dan **harga
untuk seluruh siklus dihitung server**, bukan di peramban, supaya angka di halaman depan
dan angka di faktur tidak dapat berbeda.

Ketika masa berlaku habis, **sistem berhenti sendiri**:

| Sejak masa berlaku habis | Status tenant | Yang terjadi |
| --- | --- | --- |
| Seketika | `past_due` | Menulis DIHENTIKAN. Membaca, mengunduh, dan mencetak tetap jalan. Faktur perpanjangan diterbitkan, admin diberi tahu. |
| Lewat 14 hari | `read_only` | Sama, dinaikkan agar terlihat operator. |
| Lewat 28 hari | `suspended` | Sesi yang masih terbuka dicabut. **Data tetap disimpan** — tidak ada yang dihapus karena keterlambatan. |

Dua hal yang perlu Anda ketahui sebagai operator:

1. **Blokirnya tidak menunggu cron.** Kedaluwarsa dihitung dari tanggal pada setiap
   permintaan. Jadi meski penjadwal (8.2) tidak pernah berjalan — misalnya hosting tanpa
   cron dan proses selalu idle — langganan yang habis tetap berhenti tepat waktu. Yang
   ditunda tanpa penjadwal hanyalah penerbitan faktur, pengingat, dan kenaikan tangga
   status.
2. **Ada jalan keluarnya dari dalam aplikasi.** Halaman *Langganan & Paket* tetap dapat
   dibuka saat terkunci, dan tombolnya tetap berfungsi — tetapi tombol itu **menerbitkan
   faktur**, bukan memperpanjang (lihat 8.1f). Perpanjangan yang dibayar sangat terlambat
   dihitung ulang dari tanggal pembayaran, sehingga tidak pernah menghasilkan periode yang
   sudah lewat.

Pengingat perpanjangan dikirim 7 hari sebelum berakhir, ke pemegang peran Super Admin
saja. Pengiriman itu **melewati antrean notifikasi** — baca 8.3: selama kanal email belum
diisi, pesannya menunggu di antrean dan tidak sampai ke email siapa pun.

#### 8.1f Siapa yang berwenang menyatakan sebuah faktur DIBAYAR

Ini kontrol komersial terpenting di panduan ini, dan bentuknya sengaja tidak nyaman:
**pelanggan tidak dapat menyatakan pembayarannya sendiri.**

Tombol di halaman *Langganan & Paket* hanya **menerbitkan faktur**. Masa berlaku maju
hanya setelah pembayarannya tercatat, dan yang berwenang mencatat hanya dua:

| Pencatat | Bagaimana |
|---|---|
| **Webhook payment gateway** | `POST /webhooks/payment`, tanda tangan diverifikasi dengan `VANTIK_PAYMENT_WEBHOOK_SECRET` |
| **Operator platform** | **Manajemen Tenant → Faktur menunggu pembayaran**, memakai izin `billing:settle` |

Izin `billing:settle` **ditolak secara eksplisit** untuk Super Admin tenant, meski perannya
memegang `*:*` — penolakan mengalahkan pemberian, jadi pemisahan ini tidak dapat dilanggar
tanpa menyunting definisi peran. Alasannya sederhana: pihak yang berutang tidak boleh menjadi
pihak yang menyatakan utangnya lunas.

Alur pembayaran manual (transfer bank), yang berlaku selama payment gateway belum dipilih:

1. Pelanggan menekan tombol di *Langganan & Paket* → faktur terbit, ruang kerja **tetap**
   terkunci, dan layar menyebutkan bahwa aktivasi menunggu pembayaran tercatat.
2. Pelanggan mentransfer sesuai jumlah pada faktur.
3. Operator membuka **Manajemen Tenant → Faktur menunggu pembayaran**, mengisi **nomor
   referensi** mutasi rekening, lalu menekan *Catat pembayaran*. Nomor referensi **wajib** —
   pencatatan yang tidak dapat dicocokkan dengan mutasi tidak dapat ditinjau kemudian.
4. Masa berlaku maju, ruang kerja terbuka, dan pelanggan menerima kabar lewat antrean
   notifikasi (8.3).

Dua hal yang perlu diketahui:

- **Satu faktur hanya dapat dicatat sekali.** Mencatat dua kali akan memajukan masa berlaku
  dua siklus untuk satu uang yang masuk, jadi percobaan kedua ditolak.
- **Webhook DITOLAK selama `VANTIK_PAYMENT_WEBHOOK_SECRET` kosong.** Tanpa penjagaan itu,
  tanda tangan yang sah adalah HMAC dengan kunci kosong — yang dapat dihitung siapa pun yang
  tahu rahasianya belum diisi. Jalur ini menyatakan faktur lunas, jadi terbuka tanpa sengaja
  bukan pilihan.

Setiap pencatatan tercatat di **Log Aktivitas tenant yang dibayar** — bukan tenant
operatornya — ditandai sebagai akses operator, lengkap dengan nomor referensinya. Jadi
pelanggan dapat memeriksa sendiri riwayat pembayarannya.

#### 8.1g Payment gateway: Xendit atau Midtrans (QRIS, VA, e-wallet)

Bila diisi, tombol di halaman *Langganan & Paket* menghasilkan **tautan pembayaran** —
halaman milik penyedia yang menampilkan **QRIS**, virtual account, dan e-wallet. Pelanggan
membayar di sana, penyedia mengabari sistem, dan ruang kerja terbuka **otomatis** tanpa
operator menyentuh apa pun.

Kosong secara bawaan. Selama kosong, jalur manual di 8.1f tetap berjalan apa adanya.

| Variabel | Wajib | Keterangan |
|---|---|---|
| `VANTIK_PAYMENT_PROVIDER` | ya | `xendit` atau `midtrans`. Kosong = pembayaran manual |
| `VANTIK_PAYMENT_SECRET_KEY` | ya | Xendit: *Secret API Key*. Midtrans: *Server Key* |
| `VANTIK_PAYMENT_CALLBACK_TOKEN` | Xendit | *Callback Verification Token* dari dasbor Xendit |
| `VANTIK_PAYMENT_API_BASE` | tidak | Isi untuk memakai lingkungan sandbox penyedia |
| `VANTIK_PAYMENT_SUCCESS_URL` | tidak | Tujuan setelah pembayaran selesai |
| `VANTIK_PAYMENT_FAILURE_URL` | tidak | Tujuan bila pembayaran dibatalkan |

Kanal aktif hanya bila **penyedia dan kunci rahasia** terisi. Setengah terkonfigurasi tidak
diaktifkan: tautan bayar yang pasti gagal dibuat hanya menghasilkan pesan kesalahan di layar
pelanggan, sementara "belum dikonfigurasi" menyatakan keadaan yang sebenarnya.

**Daftarkan URL kabar pembayaran di dasbor penyedia:**

```
https://analitik.contoh.id/webhooks/payment
```

- **Xendit** → *Settings → Webhooks*, isi *Invoices paid* dengan URL di atas. Salin
  *Callback Verification Token*-nya ke `VANTIK_PAYMENT_CALLBACK_TOKEN`. Xendit membuktikan
  keaslian pesan lewat token itu; **selama token kosong, seluruh kabar DITOLAK.**
- **Midtrans** → *Settings → Configuration → Payment Notification URL*. Midtrans tidak
  memakai token: ia men-hash badan pesan bersama Server Key, jadi `CALLBACK_TOKEN` boleh
  dibiarkan kosong.

Empat hal yang perlu diketahui:

1. **Satu faktur, satu tagihan.** Menekan tombol dua kali mengembalikan tautan yang sama —
   nomor pembayaran tidak berubah-ubah, dan tidak ada tagihan menumpuk di sisi penyedia.
2. **Kabar yang dikirim ulang tidak menambah masa berlaku.** Penyedia memang mengirim ulang
   kabar yang tidak dijawab `200`; pengiriman kedua dijawab "diterima" tanpa memajukan
   periode lagi.
3. **Pembayaran yang masih ditinjau tidak membuka ruang kerja.** Pada Midtrans, `capture`
   dengan `fraud_status: challenge` menunggu keputusan manual — memperlakukannya sebagai
   lunas berarti membuka ruang kerja atas pembayaran yang masih dapat dibatalkan.
4. **Gateway yang gagal tidak menggagalkan faktur.** Bila penyedia tidak dapat dihubungi,
   fakturnya tetap sah, layar pelanggan mengatakan tautannya belum dapat dibuat, dan
   pembayaran manual tetap dapat dicatat operator.

Data kartu **tidak pernah** melewati sistem ini (SECURITY.md 16.3): yang disimpan hanya
tautan pembayaran, rujukan transaksi, dan nama cara bayarnya.

Endpoint `/webhooks/payment` **tidak memerlukan sesi** — payment gateway tidak punya, dan
tidak boleh punya. Yang membuktikan keaslian pesan adalah tanda tangannya, dan verifikasi
itulah otentikasinya. Endpoint ini dibatasi 120 permintaan per menit per alamat IP, cukup
longgar karena penyedia mengirim ulang kabar yang belum dijawab `200`.

Setiap pembayaran yang dikonfirmasi gateway tercatat di **Log Aktivitas tenant** dengan
aktor `gateway:xendit` / `gateway:midtrans` — dibedakan dari `billing.payment_recorded` yang
dicatat operator manusia, sehingga riwayatnya dapat dibaca: mana yang otomatis, mana yang
dicocokkan manusia.

> **Bila Anda memperbarui dari versi sebelumnya:** izin peran standar disegarkan dari kode
> setiap kali aplikasi menyala, jadi pengetatan ini berlaku **setelah restart** — termasuk
> untuk tenant yang sudah ada. Sebelumnya izin peran hanya ditulis sekali saat tenant dibuat,
> sehingga pengetatan keamanan di kode tidak pernah sampai ke pelanggan lama. Peran **kustom**
> milik tenant tidak disentuh.

#### 8.1e Uji coba gratis: MATI secara bawaan

Ruang kerja baru **tidak** mendapat masa pakai gratis. Alasannya komersial: pendaftaran
mandiri yang menghadiahkan masa pakai penuh dapat diulang dengan alamat email baru, sehingga
satu orang memakai platform tanpa pernah membayar — dan persetujuan admin hanya memindahkan
beban itu ke manusia yang harus menebak mana pendaftar sungguhan, setiap hari.

Yang terjadi pada ruang kerja yang baru dibuat:

| Keadaan | Yang bisa dilakukan |
|---|---|
| Menunggu persetujuan admin | Belum dapat dimasuki sama sekali (lihat 8.1c) |
| Sudah disetujui, belum dibayar | **Dapat dimasuki dan dibaca**, tetapi penulisan dihentikan |
| Pembayaran pertama tercatat | Terbuka penuh, masa berlaku mulai berjalan |

Dua gerbang itu berdiri sendiri — disetujui bukan berarti aktif.

Pesannya **dibedakan** dari kedaluwarsa: ruang kerja yang belum pernah dibayar berbunyi
"belum aktif — pembayaran pertama belum tercatat" dan mengarahkan ke **aktivasi**, bukan ke
perpanjangan sesuatu yang belum pernah berjalan. Tombolnya pun berbunyi *Aktifkan*, bukan
*Perpanjang*. Perbedaan itu disimpan di kolom `subscriptions.activated_at`.

Bila Anda **memang** ingin menawarkan uji coba, isi jumlah harinya:

```
VANTIK_TRIAL_DAYS=14
```

Kosong atau `0` berarti tidak ada uji coba. Nilai yang tidak dapat dibaca sebagai angka
diabaikan — salah ketik di `.env` tidak akan berarti "uji coba selama NaN hari".

Dua catatan:

- **Pelanggan yang sudah berjalan tidak terpengaruh.** Perubahan ini hanya berlaku untuk
  tenant yang dibuat sesudahnya; langganan yang sudah aktif tetap aktif.
- **Data contoh tetap punya uji coba**, karena memang menyebut jumlah harinya sendiri —
  akun `ujicoba` di 8.1 masih memperagakan peringatan masa berlaku sebagaimana mestinya.

### 8.2 Penjadwal: pasang cron bila hosting mendukungnya

Aplikasi punya ticker dalam proses yang menyapu ambang batas KPI, laporan terjadwal, dan
masa berlaku langganan setiap 5 menit, plus penyusulan saat proses dinyalakan. Itu cukup
untuk situs yang ramai,
**tetapi Passenger mematikan proses yang idle** — pada situs yang sepi, tidak ada proses
yang hidup untuk melakukan sapuan, sehingga ambang batas yang terlampaui tengah malam tidak
diketahui siapa pun sampai ada orang membuka aplikasi.

Bila hosting Anda punya cron, itu dapat diperbaiki sepenuhnya:

1. Isi `VANTIK_SCHEDULER_TOKEN` di `.env` dengan nilai acak
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
2. Tambahkan cron job:

```
*/10 * * * * curl -fsS -X POST https://analitik.contoh.id/api/v1/system/scheduler/run \
               -H "X-Vantik-Scheduler-Token: TOKEN_ANDA" >/dev/null
```

Endpoint itu diautentikasi dengan token bersama, **bukan sesi**: cron tidak punya sesi, dan
menyimpan kata sandi akun manusia di crontab jauh lebih buruk. Tanpa token yang diset,
endpoint MENOLAK semua permintaan — terbuka tanpa sengaja bukan pilihan.

Status pekerjaan dapat dibaca di `GET /api/v1/system/scheduler`: kapan terakhir berjalan,
hasilnya, dan tenant mana yang gagal.

### 8.3 Notifikasi: isi kredensial agar benar-benar terkirim

Ini perlu dibaca sebelum mengandalkan Alert Center atau pemulihan perangkat.

Transportnya **sudah terpasang** untuk tiga kanal — email (SMTP), WhatsApp, dan Telegram —
tetapi **seluruh nilainya dibiarkan kosong**. Selama kosong, aplikasi berperilaku persis
seperti sebelumnya: pesan **diantre tanpa dikirim**, dan status pesan tetap `queued`, bukan
`delivered`. Itu disengaja — "tercatat terkirim" yang salah lebih berbahaya daripada
kegagalan yang terlihat, terutama untuk OTP dan kode pemulihan kata sandi.

Selama kanal belum diisi, dua hal berikut berlaku:

- Notifikasi ambang batas tidak sampai ke penerima.
- **OTP pemindahan perangkat** menunggu di antrean. Admin harus membacanya dari antrean dan
  menyampaikannya lewat kanal terpercaya.

Periksa antreannya di `GET /api/v1/notifications/outbox` (butuh izin `device:read`). Isi
pesan sensitif seperti OTP **tidak** disertakan di daftar itu — membiarkannya terbaca akan
membuat siapa pun dengan izin tersebut dapat menyelesaikan pemindahan perangkat orang lain.

Kanal mana yang sudah hidup dapat dilihat di `GET /api/v1/system/notification-channels`.
Endpoint itu menyebut **nama kanal saja** — tanpa host, pengirim, maupun token — supaya
memeriksa konfigurasi tidak sama dengan membocorkannya.

#### 8.3a Email (SMTP)

Isi di `.env` atau di *Environment variables* panel hosting. Kanal email hanya menyala bila
`VANTIK_SMTP_HOST` **dan** `VANTIK_SMTP_FROM` terisi:

| Variabel | Wajib | Keterangan |
|---|---|---|
| `VANTIK_SMTP_HOST` | ya | Misal `mail.domainanda.id` — biasanya tertulis di cPanel → Email Accounts → Connect Devices |
| `VANTIK_SMTP_PORT` | tidak | Bawaan `587`. Pakai `465` bila hosting hanya membuka TLS langsung |
| `VANTIK_SMTP_USER` | tidak | Alamat email penuh; kosongkan hanya bila server benar-benar tanpa autentikasi |
| `VANTIK_SMTP_PASSWORD` | tidak | Kata sandi akun email tersebut |
| `VANTIK_SMTP_FROM` | ya | Alamat pengirim. Banyak server menolak `MAIL FROM` yang bukan miliknya |
| `VANTIK_SMTP_IMPLICIT_TLS` | tidak | `true`/`false`. Bawaannya diturunkan dari port (465 → `true`) |
| `VANTIK_SMTP_ALLOW_INSECURE_TLS` | tidak | Lihat peringatan di bawah |

Dua hal yang perlu diketahui sebelum mengisinya:

- **Tidak ada mode tanpa enkripsi.** Pada port 587, aplikasi meminta `STARTTLS`; bila server
  tidak menawarkannya, pengiriman **dibatalkan** dengan alasan `server_without_starttls`
  alih-alih meneruskan kata sandi dan kode pemulihan dalam bentuk polos.
- **`VANTIK_SMTP_ALLOW_INSECURE_TLS=true` hanya untuk sertifikat mail yang tidak cocok dengan
  nama host** — keadaan yang memang ada di sebagian shared hosting. Menyalakannya berarti
  menerima bahwa lalu lintasnya dapat disadap pihak yang mampu menyisipkan diri, termasuk isi
  OTP yang lewat di sana. Bawaannya mati; biarkan mati bila pengiriman sudah berhasil.

#### 8.3b WhatsApp

Berbentuk **template**, bukan bentuk milik satu penyedia — karena "API WhatsApp" bukan satu
hal: WhatsApp Cloud API milik Meta, Fonnte, Wablas, dan Twilio berbeda bentuk badannya.
Kanal ini menyala bila `VANTIK_WHATSAPP_URL` terisi:

| Variabel | Wajib | Keterangan |
|---|---|---|
| `VANTIK_WHATSAPP_URL` | ya | Endpoint kirim pesan milik penyedia Anda |
| `VANTIK_WHATSAPP_TOKEN` | tidak | Bila diisi, dikirim sebagai `Authorization: Bearer <token>` |
| `VANTIK_WHATSAPP_METHOD` | tidak | Bawaan `POST` |
| `VANTIK_WHATSAPP_HEADERS` | tidak | Objek JSON satu baris untuk header non-standar |
| `VANTIK_WHATSAPP_BODY_TEMPLATE` | tidak | Bawaannya bentuk WhatsApp Cloud API |

Placeholder yang tersedia di template: `{{recipient}}`, `{{subject}}`, `{{body}}`. Ketiganya
disisipkan sebagai string JSON yang **sudah di-escape**, jadi tanda kutip atau baris baru di
dalam pesan tidak merusak badan permintaan. Contoh untuk penyedia lokal bergaya sederhana:

```
VANTIK_WHATSAPP_BODY_TEMPLATE={"target":"{{recipient}}","message":"{{subject}}\n{{body}}"}
```

Nomor penerima mengikuti format yang diminta penyedia (umumnya `62…`, tanpa `+` dan tanpa
`0` di depan). Yang dikirim aplikasi adalah nomor yang tersimpan di profil pengguna apa
adanya — bila penyedia menolaknya, perbaiki di profil, bukan di template.

#### 8.3c Telegram

| Variabel | Wajib | Keterangan |
|---|---|---|
| `VANTIK_TELEGRAM_BOT_TOKEN` | ya | Token dari [@BotFather](https://t.me/BotFather) |
| `VANTIK_TELEGRAM_API_BASE` | tidak | Bawaan `https://api.telegram.org` |

Penerima Telegram adalah **chat id**, bukan nomor telepon atau username. Pengguna harus
menekan *Start* pada bot lebih dulu — Telegram tidak mengizinkan bot memulai percakapan.

#### 8.3d Setelah diisi: bagaimana antrean terkuras

Setelah mengisi salah satu kanal, **restart aplikasi** (Setup Node.js App → Restart);
konfigurasi dibaca sekali saat proses menyala.

Pengiriman berjalan di dua tempat, dan keduanya perlu diketahui:

1. **Segera saat pesan dibuat.** Begitu ada pesan masuk antrean, pengiriman dimulai tanpa
   menunggu apa pun — OTP pemindahan perangkat hanya berguna dalam hitungan menit. Ini
   berjalan setelah respons dikirim, jadi pengguna tidak menunggu percakapan SMTP selesai.
2. **Sapuan berkala `notification.dispatch`.** Passenger mematikan proses yang idle, sehingga
   pengiriman di langkah 1 dapat mati di tengah jalan. Sapuan inilah yang membuat pesan yang
   tertinggal akhirnya tetap terkirim — dan di situs yang sepi, sapuan itu hanya jalan bila
   **cron penjadwal terpasang** (lihat 8.2). Tanpa cron, pesan yang tertinggal menunggu
   sampai ada orang membuka aplikasi.

Antrean lama ikut terkirim: pesan yang menumpuk selama kredensial belum diisi tidak hilang,
ia dikirim pada sapuan pertama setelah restart.

Yang terjadi bila pengiriman gagal:

- Pesan **tetap `queued`** dan dicoba lagi, sampai **5 percobaan**. Gangguan sesaat pada
  server email tidak dianggap permanen pada kegagalan pertama.
- Setelah percobaan kelima, statusnya menjadi `failed` dengan alasan terakhir tercatat.
  Berhenti mencoba itu disengaja: setiap percobaan pada alamat yang memang salah membayar
  timeout 15 detik dan memperlambat pesan lain yang masih dapat terkirim.
- Kanal yang **belum** dikonfigurasi (misal Teams atau Slack bila Anda hanya mengisi SMTP)
  **dilewati** — tetap `queued`, percobaannya tidak terpakai, dan isinya tetap dapat dibaca
  operator untuk disampaikan manual. Itu bukan kegagalan; itu "belum ada tujuannya".

Periksa hasilnya di `GET /api/v1/notifications/outbox`: `sent` berarti benar-benar terkirim,
`failed` disertai alasan singkat (misal `smtp_535`, `econnrefused`, `whatsapp_http_401`).
Alasannya sengaja hanya berupa kode — bukan pesan penuh — karena pesan kesalahan sering
memuat URL berikut tokennya, dan kolom ini dapat dibaca operator.

Satu hal yang berubah setelah pengiriman aktif: **isi pesan sensitif (OTP dan kode pemulihan)
dihapus dari antrean begitu benar-benar terkirim.** Sebelum ada transport, isi itu satu-satunya
salinan yang dapat dibacakan Admin; setelah sampai ke penerimanya, ia berhenti menjadi jalan
pemulihan dan tinggal menjadi rahasia yang mengendap di basis data. Pengguna yang tidak
menerima emailnya cukup meminta kode baru.

---

## 8.4 Pemangkasan tabel yang terus tumbuh

Beberapa tabel bertambah pada setiap pemakaian dan tidak pernah menyusut sendiri:
percobaan login, sesi yang kedaluwarsa, tantangan MFA, jejak dasbor tertanam, cache hasil
analisis, dan pembacaan sensor Digital Twin. Di shared hosting yang berkuota disk, itu
berarti berkas basis data membengkak karena hal-hal yang sudah tidak menjawab pertanyaan
siapa pun.

Pekerjaan **`retention.prune`** menanganinya, berjalan bersama penjadwal (8.2). Ia
**global**, dijalankan sekali per putaran — bukan sekali per tenant — karena sebagian
baris memang tidak punya tenant: percobaan login untuk alamat email yang tidak terdaftar
sengaja bertenant kosong supaya ia tidak membocorkan tenant mana yang memiliki alamat itu.

Jendela bawaannya sudah wajar dan tidak perlu diubah. Bila perlu, setel lewat variabel
lingkungan — satuannya **hari**, dan `0` mematikan pemangkasan tabel itu:

| Variabel | Bawaan | Yang dipangkas |
|---|---|---|
| `VANTIK_RETAIN_LOGIN_ATTEMPTS_DAYS` | 90 | Percobaan login |
| `VANTIK_RETAIN_DEAD_SESSIONS_DAYS` | 30 | Sesi yang **sudah** kedaluwarsa atau dicabut |
| `VANTIK_RETAIN_MFA_CHALLENGES_DAYS` | 30 | Tantangan MFA yang sudah dipakai/kedaluwarsa |
| `VANTIK_RETAIN_PASSWORD_RESETS_DAYS` | 30 | Permintaan reset kata sandi yang sudah selesai |
| `VANTIK_RETAIN_EMBED_REQUESTS_DAYS` | 365 | Jejak permintaan dasbor tertanam |
| `VANTIK_RETAIN_SENSOR_READINGS_DAYS` | 90 | Pembacaan sensor Digital Twin |
| `VANTIK_RETAIN_SENT_NOTIFICATIONS_DAYS` | 30 | Pesan outbox yang **berhasil terkirim** |
| `VANTIK_RETAIN_ANALYSIS_CACHE_DAYS` | 30 | Cache hasil analisis statistik |
| `VANTIK_RETAIN_SCHEDULER_RUNS_DAYS` | 30 | Jejak eksekusi penjadwal |

Tiga hal yang **tidak** akan dipangkas, dan itu disengaja:

- **Sesi yang masih hidup** tidak pernah dihapus, betapa pun tuanya. Mengeluarkan orang
  dari aplikasi demi ruang disk adalah kerusakan, bukan perawatan.
- **Pesan outbox berstatus `queued` atau `failed`** tidak pernah dibuang. Selama transport
  email belum dipasang (8.3), antrean itu satu-satunya tempat kode pemulihan kata sandi dan
  OTP dapat dibaca operator — membuangnya berarti menghapus satu-satunya salinannya.
- **`audit_log` dan `usage_events`** — lihat 9b.

Lihat apa yang tumbuh, beserta jendela yang sedang berlaku, di
`GET /api/v1/system/retention` (butuh izin `platform:health`).

## 9. Backup

Seluruh keadaan aplikasi ada di tiga berkas dalam `~/vantik-data/`:

| Berkas | Isi |
|---|---|
| `vantik.db` | data operasional |
| `vantik-audit.db` | Log Aktivitas (append-only, immutable) |
| `vantik-vault.db` | kredensial Koneksi Eksternal terenkripsi |

Cara aman menyalin saat aplikasi berjalan (WAL aktif, jadi menyalin berkas mentah bisa
menghasilkan salinan tidak konsisten):

```bash
cd ~/vantik-data
for f in vantik vantik-audit vantik-vault; do
  sqlite3 "$f.db" ".backup '/home/$USER/backup/$f-$(date +%F).db'"
done
```

Bila `sqlite3` CLI tidak tersedia di hosting, hentikan aplikasi sesaat
(**Setup Node.js App → Stop**), salin ketiga berkas beserta `-wal`/`-shm`, lalu
**Start** kembali.

> `vantik-vault.db` tidak berguna tanpa `VANTIK_MASTER_KEY`. Simpan keduanya —
> tetapi **jangan di tempat yang sama**, karena itu menghilangkan gunanya enkripsi.

---

### 9b. Log Aktivitas: rotasi berkas, bukan penghapusan baris

`vantik-audit.db` **tidak dapat dipangkas.** Tabelnya dijaga trigger SQLite yang
membatalkan setiap `UPDATE` dan `DELETE` — termasuk dari Super Admin, termasuk untuk
keperluan pengarsipan (SECURITY.md Bagian 9). Itu bukan kekurangan yang perlu ditambal;
itu justru alasan basis data ini dipisahkan.

Konsekuensinya jujur: **berkas audit tumbuh selamanya.** Pada pemakaian internal
pertumbuhannya lambat — beberapa MB per tahun untuk puluhan pengguna — tetapi ia tidak
pernah berhenti. Periksa angkanya di `GET /api/v1/system/retention`, bagian `appendOnly`.

Bila suatu saat ukurannya menjadi masalah, yang benar adalah **merotasikan berkasnya**,
bukan menghapus barisnya:

```bash
# 1. Hentikan aplikasi: Setup Node.js App → Stop
cd ~/vantik-data

# 2. Simpan berkas audit sekarang sebagai arsip bertanggal, beserta -wal/-shm
for ext in "" "-wal" "-shm"; do
  [ -f "vantik-audit.db$ext" ] && mv "vantik-audit.db$ext" "vantik-audit-$(date +%Y%m)-arsip.db$ext"
done

# 3. Nyalakan kembali: Setup Node.js App → Start
#    Aplikasi membuat vantik-audit.db baru dan melanjutkan pencatatan.
```

Yang perlu Anda ketahui sebelum melakukannya:

- **Tidak ada yang hilang.** Berkas arsip tetap utuh dan tetap kekal. Simpan ia bersama
  backup Anda; ia dapat dibuka kapan pun dengan `sqlite3` bila auditor memintanya.
- **Log Aktivitas di aplikasi hanya menampilkan berkas yang aktif.** Setelah rotasi,
  riwayat sebelum tanggal rotasi tidak lagi muncul di antarmuka — ia ada di berkas arsip.
  Itu cara kerja rotasi log pada umumnya, dan lebih baik daripada melemahkan kekekalannya.
- **Catat tanggal rotasinya** di luar sistem, supaya jelas berkas mana memuat periode mana.

> Ada tabel `audit_log_archive` di dalam basis data audit. Ia **menyalin**, bukan
> memindahkan — mengisinya justru MENAMBAH ukuran berkas. Gunanya menghasilkan salinan
> berbentuk tunggal yang mudah diekspor keluar, bukan mengosongkan tabel sumbernya.

## 10. Memperbarui ke versi baru

```bash
# di lokal
git pull && npm install && npm run build && npm run package
```

Unggah isi `deploy/` menimpa `~/vantik/`, **kecuali** `.env` (jangan ditimpa). Lalu:

```bash
cd ~/vantik && npm install --omit=dev
```

**Setup Node.js App → Restart**.

Migrasi skema berjalan otomatis saat startup dan bersifat aditif — kolom baru selalu
nullable dulu (DEPLOYMENT.md Bagian 6), sehingga versi lama tetap dapat membaca basis
data bila perlu rollback. `vantik-audit.db` tidak pernah menerima `UPDATE`/`DELETE`;
migrasinya hanya menambah struktur.

---

## 11. Batasan shared hosting yang perlu diketahui

Bersikap jujur di muka lebih baik daripada Anda menemukannya saat sudah dipakai:

| Batasan | Dampak | Jalan keluar |
|---|---|---|
| Proses di-recycle saat idle | Permintaan pertama setelah menganggur terasa lambat (beberapa detik) | Wajar untuk pemakaian internal. Bila tidak dapat diterima, pindah ke VPS. |
| Batas memori (biasanya 512MB–1GB) | Dataset sangat besar (ratusan ribu baris) dapat menyentuh batas saat analisis | Pecah dataset, atau naikkan paket/pindah ke VPS. Target performa PRD Bagian 7 (100.000 baris) diukur pada infrastruktur khusus, bukan shared hosting. |
| Batas CPU bersama | Forecast/regresi pada dataset besar lebih lambat | Jalankan pada jam senggang, atau pindah ke VPS. |
| Tanpa cron sub-menit | Penjadwalan laporan & sinkronisasi bergantung cron cPanel (minimum 1 menit) | Cukup untuk kebutuhan harian/jam. |
| SQLite, bukan basis data server | Penulisan bersamaan bertumpu pada satu berkas | Memadai untuk puluhan pengguna aktif. Untuk ratusan pengguna, pindah ke VPS. |
| Tanpa MQTT | Digital Twin menerima data sensor lewat REST, bukan MQTT | Kirim pembacaan sensor ke `POST /api/v1/twin/readings`. |

**Kesimpulan jujur:** shared hosting cocok untuk pilot, satu divisi, atau organisasi
kecil-menengah dengan pemakaian internal. Untuk beban penuh yang dibayangkan PRD
(multi-tenant SaaS dengan target uptime 99.5%), infrastruktur di `infra/k8s/`
adalah target yang benar.

---

## 12. Bila gagal

| Gejala | Penyebab paling sering |
|---|---|
| `503 Service Unavailable` | Aplikasi gagal start. Baca `stderr.log` di direktori aplikasi. |
| `VANTIK_MASTER_KEY wajib diset di production` | Variabel lingkungan belum diisi (langkah 4). Ini penolakan yang disengaja. |
| `Tidak ada driver SQLite yang dapat dipakai` | Node < 22.5 **dan** better-sqlite3 gagal terpasang. Naikkan versi Node. |
| `SQLITE_CANTOPEN` | `VANTIK_DATA_DIR` salah, atau folder belum dibuat/tidak dapat ditulis. |
| Halaman putih, API jalan | `public/` tidak terunggah. Periksa `~/vantik/public/index.html` ada. |
| `exports is not defined` | Ada `"type": "module"` di `package.json` aplikasi. `package.json` bawaan paket tidak memuatnya — jangan ditambahkan. |
| Login gagal padahal kata sandi benar | Perangkat lain sudah terikat akun (PRD 6.30). Lepas ikatan lewat menu **Perangkat & Sesi**, atau naikkan batas perangkat per akun. |
