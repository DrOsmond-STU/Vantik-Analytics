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
- [ ] Kata sandi admin default sudah diganti; seed demo tidak dijalankan di production
- [ ] `VANTIK_MASTER_KEY` tercatat di pengelola kata sandi organisasi
- [ ] **Verifikasi dua langkah admin sudah diaktifkan** (lihat 8.1 — wajib sebelum admin dapat bekerja)
- [ ] **Kode pemulihan admin sudah dicetak/disimpan di luar sistem**
- [ ] Backup `~/vantik-data/` masuk jadwal backup hosting

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

---

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
