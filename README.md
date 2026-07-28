# Vantik Analytics

**Enterprise Analytics Intelligence Platform** — implementasi dari PRD v1.5, ARCHITECTURE.md v1.0,
DESIGN.md v1.0, SECURITY.md v1.0, BRAND.md v1.0, TESTING.md v1.0, dan DEPLOYMENT.md v1.0.

> *"Satu sudut pandang, seluruh organisasi."*

Platform ini **domain-agnostic** (PRD Bagian 3.1): seluruh modul bekerja pada struktur data
generik (fact & dimension), sehingga metrik, dimensi, dan istilah sepenuhnya dikonfigurasi
organisasi pengguna — bukan ditanam di kode.

---

## Menjalankan

```bash
npm install
npm run seed     # menanam tenant demo + data sintetis lintas sektor
npm run dev      # API :4000 · web app :5173
```

Akun demo (kata sandi sama untuk semuanya: `VantikDemo#2026`):

| Email | Peran | MFA |
|---|---|---|
| `admin@demo.vantik.id` | Super Admin | **wajib** |
| `rizky@demo.vantik.id` | Supervisor *(dibatasi RLS ke Wilayah Timur)* | — |
| `sari@demo.vantik.id` | Manager | — |
| `bagas@demo.vantik.id` | Data Engineer | **wajib** |
| `maya@demo.vantik.id` | Data Steward | **wajib** |
| `andi@demo.vantik.id` | Business Analyst + AI Analyst | — |
| `putri@demo.vantik.id` | Auditor | — |

Kode organisasi: `demo`.

Tiga akun bertanda **wajib** dapat masuk tetapi belum berwenang apa pun sampai verifikasi
dua langkah diaktifkan — buka **Perangkat & Sesi → Verifikasi Dua Langkah**. Itu perilaku
yang disengaja (SECURITY.md Bagian 4), bukan kerusakan. Untuk menjelajah cepat tanpa
menyiapkan autentikator, masuk sebagai `andi@demo.vantik.id` — peran Business Analyst +
AI Analyst mencakup hampir seluruh modul analitik.

```bash
npm run build         # typecheck API + kompilasi ke JS + build web app
npm test              # 381 test (357 backend + 24 komponen web)
npm run test:coverage # backend dengan ambang cakupan
npm run test:web      # hanya uji komponen/DOM web app
```

---

## Memasang di server

### Shared hosting (cPanel / Passenger) — tanpa Docker

```bash
npm install
npm run build      # menghasilkan services/dist (CommonJS) + frontend/web-app/dist
npm run package    # menyusun folder deploy/ siap unggah
```

Unggah isi `deploy/` ke server, buat aplikasi Node lewat cPanel **Setup Node.js App** dengan
berkas startup `app.js`, lalu ikuti **[docs/DEPLOY-SHARED-HOSTING.md](docs/DEPLOY-SHARED-HOSTING.md)**
— berisi tata letak direktori, variabel lingkungan, penyediaan tenant produksi, daftar periksa
pasca-pasang, backup, dan **batasan nyata shared hosting** yang dinyatakan terbuka.

Tiga hal yang membuat pemasangan ini mungkin tanpa akses root:

- **Tanpa modul native wajib.** `better-sqlite3` berstatus `optionalDependencies`; bila
  kompilasinya gagal — hal biasa di shared hosting — aplikasi otomatis memakai `node:sqlite`
  bawaan Node ≥ 22 (`services/src/platform/sqlite.ts`). `npm install` tetap berhasil.
- **Keluaran CommonJS.** Passenger memuat berkas startup lewat `require()`; ESM gagal di sana.
- **Berkas basis data di luar document root.** Default `VANTIK_DATA_DIR=../vantik-data`, dan
  aplikasi menolak menyajikan lintasan berkas apa pun yang tidak ada di `public/` (404),
  terlepas dari ada tidaknya `.htaccess`.

### VPS / kontainer

`infra/Dockerfile` untuk pemasangan yang punya akses root; paket `deploy/` yang sama juga
jalan langsung dengan `node app.js`. `infra/k8s/` baru memuat **network policy** —
manifest Deployment/Service/Ingress belum ada dan perlu ditulis sesuai klaster tujuan.

---

## Struktur repositori

Mengikuti **ARCHITECTURE.md Bagian 10**. Gaya arsitektur: *modular monolith* dengan batas
domain (*bounded context*) yang sudah dipisah sejak awal, agar dapat dipecah menjadi
microservices tanpa refactor besar.

```
vantik-analytics/
├── services/src/
│   ├── platform/                 # kernel: tenancy, RBAC, RLS, crypto, feature flag, HTTP
│   ├── data-platform-service/    # Dataset, Koneksi Eksternal, Data Modeling, DQ Center, KPI Center
│   ├── stats-service/            # Statistik Deskriptif, Uji Hipotesis, Regresi & Korelasi
│   ├── ai-engine-service/        # AI Analytics, Forecast, RCA, Discovery, Narrative
│   ├── designer-service/         # Dashboard/Report Designer, Interactive Viz, Embed
│   ├── alerting-service/         # Alert Center
│   ├── iot-gateway-service/      # Digital Twin
│   ├── identity-service/         # Master Pegawai, Otorisasi User, Perangkat & Sesi
│   ├── audit-service/            # Log Aktivitas (append-only, basis data terpisah)
│   ├── tenant-service/           # Manajemen Tenant
│   ├── billing-service/          # Langganan & Paket, Billing & Faktur
│   ├── metering-service/         # Usage Metering & Kuota
│   ├── presentation-service/     # Executive/Operational Cockpit, Balanced Scorecard
│   └── app.ts                    # komposisi modular monolith (satu-satunya titik rakit)
├── frontend/web-app/             # React + Vite; 30 modul, Dark/Light, ID/EN
├── shared/design-tokens/         # sumber tunggal token DESIGN.md
├── scripts/package-deploy.mjs    # menyusun deploy/ siap unggah ke shared hosting
├── docs/
│   ├── DEPLOY-SHARED-HOSTING.md  # panduan pasang cPanel/Passenger + batasannya
│   └── SAST-TRIAGE.md            # temuan CodeQL yang tidak diperbaiki + alasannya
└── infra/
    ├── shared-hosting/           # .htaccess, contoh .env produksi
    ├── Dockerfile
    └── k8s/                      # baru network policy; Deployment/Service belum ada
```

---

## Cakupan implementasi

**30 modul dalam 8 domain** tersedia di navigasi dan didukung API. Kedalaman implementasinya
berbeda-beda dan dinyatakan jujur di bawah — mengikuti prioritas rilis PRD Bagian 10 (R1 → R4).

| Domain | Modul | Status |
|---|---|---|
| 1. Kepemimpinan | Executive Cockpit, Operational Cockpit, Balanced Scorecard | Fungsional |
| 2. Visualisasi & Pelaporan | Dashboard Designer, Report Designer, Interactive Visualization, Embed Dashboard | Fungsional; designer memakai penataan widget berbasis daftar, belum *drag-and-drop* penuh |
| 3. Analitik Cerdas (AI) | AI Analytics, Forecast Analytics, RCA, Data Discovery, AI Narrative Report | Fungsional dengan penyedia **deterministik** bawaan; antarmuka `LlmProvider` siap dipasangi LLM eksternal/self-hosted |
| 4. Analisis Statistik | Statistik Deskriptif, Uji Hipotesis, Regresi & Korelasi | Fungsional penuh, terverifikasi terhadap nilai rujukan |
| 5. Manajemen Data | Dataset, Koneksi Eksternal, Data Modeling, Data Quality Center, KPI Center | Fungsional penuh |
| 6. Monitoring | Alert Center, Digital Twin | Fungsional dengan **penjadwal**: ambang batas KPI disapu berkala, bukan hanya saat ada panggilan API. Pengiriman kanal lewat `NotificationTransport`, ingest sensor lewat HTTP (MQTT belum) |
| 7. Administrasi Sistem | Master Pegawai, Otorisasi User, Log Aktivitas, Perangkat & Sesi | Fungsional penuh |
| 8. Langganan & Billing | Manajemen Tenant, Langganan & Paket, Billing & Faktur, Usage Metering & Kuota | Fungsional; *payment gateway* lewat webhook terverifikasi tanda tangan |

### Yang sengaja belum diimplementasikan

Dinyatakan terbuka, bukan disembunyikan:

- **Parsing XLSX** — unggahan `.xlsx` divalidasi lalu **ditolak dengan alasan jelas**
  (`error.xlsx_conversion_required`), bukan diam-diam menghasilkan dataset kosong.
- **Driver koneksi eksternal nyata** — `ConnectionProbe` memvalidasi bentuk konfigurasi;
  implementasi driver PostgreSQL/MySQL/Oracle/REST dipasang lewat antarmuka yang sama.
- **Pengiriman notifikasi nyata** — `QueueOnlyTransport` mengantre tanpa mengirim, dan
  **menyatakannya**: `delivers = false`, statusnya tetap `queued`, dan antreannya terlihat
  di `GET /api/v1/notifications/outbox`. SMTP/WhatsApp/Telegram/SMS/Teams/Slack dipasang
  lewat `NotificationTransport`. Sampai itu dipasang, OTP pemindahan perangkat menunggu di
  outbox dan Admin harus menyampaikannya.
- **SSO SAML/OIDC** — skema & kolom `auth_provider` sudah ada; alur federasi belum. (MFA berbasis TOTP **sudah** ada — lihat tabel kontrol keamanan.)
- **Ingest MQTT** — Digital Twin menerima pembacaan sensor lewat REST; gateway MQTT belum.
- **Ekspor PDF biner** — `renderDocument()` mengembalikan struktur dokumen; render PDF
  dilakukan di sisi klien/worker.

### Pertanyaan terbuka yang memengaruhi implementasi

PRD Bagian 12 masih menyisakan keputusan bisnis. Yang diasumsikan sementara di kode:

| Pertanyaan (PRD 12) | Asumsi sementara |
|---|---|
| LLM eksternal atau self-hosted? | Platform berfungsi **penuh tanpa LLM** (penyedia deterministik). Penyedia eksternal opsional dan datanya dimasking lebih dulu. |
| Harga final tiap paket & diskon tahunan | Angka indikatif di `featureFlags.ts`; tidak dipakai untuk penagihan nyata. |
| Payment gateway mana | Diabstraksi sebagai webhook terverifikasi tanda tangan; tidak terikat vendor. |
| Lama uji coba gratis | Default 14 hari, parameter `trialDays`. |
| Retensi Log Aktivitas | Fungsi arsip tersedia; kebijakan retensi belum dipatok. |
| Retensi data pasca-berhenti langganan | 90 hari (`POST_CANCELLATION_RETENTION_DAYS`). |

---

## Kontrol keamanan yang ditegakkan secara struktural

SECURITY.md menuntut kontrol yang **struktural, bukan bergantung disiplin individu**.
Yang membuatnya sulit dilanggar tanpa sengaja:

| Kontrol | Cara ditegakkan |
|---|---|
| **Isolasi tenant** (16.1) | Modul tidak pernah menerima koneksi basis data mentah — hanya `TenantScopedDb`, yang menyuntikkan `tenant_id` otomatis dan **menolak SQL mentah** yang menyentuh tabel ber-tenant tanpa filter. `tenant_id` selalu dari sesi terverifikasi, tidak pernah dari input klien. |
| **Log Aktivitas immutable** (9) | Basis data **terpisah secara fisik** + TRIGGER SQLite yang membatalkan setiap `UPDATE`/`DELETE` — termasuk dari Super Admin dan administrator basis data. |
| **Secrets vault terpisah** (6) | Kredensial Koneksi Eksternal AES-256-GCM di berkas basis data tersendiri; tidak ada endpoint yang dapat mengembalikan nilainya. |
| **Deny overrides allow** (5) | Resolusi izin menerapkan penolakan **setelah** union, sehingga `*:*` sekalipun kalah oleh pengecualian eksplisit. |
| **RLS di level query** (5) | Difilter di server sebelum respons dibentuk; baris tanpa kolom dimensi pembatas **ditolak** (fail secure). |
| **Objek tenant lain → 404** | Membalas 403 akan membocorkan keberadaan objek milik tenant lain. |
| **Embed** (15) | Token ter-hash, RLS dievaluasi ulang tiap permintaan, domain whitelist di server, `frame-ancestors` per token, pencabutan berlaku pada permintaan berikutnya, tanpa ekspor. |
| **Device binding** (17) | Fingerprint dihash **di server**; masukan klien tidak tepercaya. Toleransi kemiripan agar pembaruan browser tidak mengunci pengguna sah. |
| **Penyajian berkas statis** (7) | Frontend dilayani berdasarkan **bentuk lintasan**, bukan daftar-tolak nama berkas: hanya lintasan tanpa ekstensi (rute SPA) yang dijawab `index.html`; permintaan berkas di luar `public/` selalu 404. Tidak bergantung pada `.htaccess`, sehingga berlaku juga di VPS tanpa Apache. |
| **CSRF** (4) | Cookie sesi hanya diterima untuk metode yang **tidak** mengubah keadaan; setiap penulisan wajib membawa `Authorization: Bearer`. Peramban tidak dapat menambahkan header itu pada permintaan lintas-situs tanpa lolos preflight CORS, sehingga kelas serangannya hilang — bukan hanya dipersulit oleh `SameSite=Lax`. |
| **Keacakan** (4) | OTP pemindahan perangkat dan bagian acak seluruh ID objek berasal dari `randomInt`/`randomBytes`. `Math.random()` dapat diprediksi dari beberapa keluaran, dan OTP adalah faktor autentikasi. |
| **MFA wajib per peran** (4) | Lima peran menandai `mfaRequired`; penegakannya di `RequestContext.require()`, sehingga berlaku untuk **setiap** modul tanpa tiap rute perlu mengingatnya. Sebelum MFA aktif, pemegang peran itu dapat masuk tetapi tidak berwenang apa pun. TOTP diimplementasikan di atas `node:crypto` (tanpa dependensi tambahan) dan diuji terhadap vektor resmi RFC 6238. |
| **Pemulihan perangkat** (17.4) | Pengguna dengan perangkat baru punya jalur nyata: ajukan (kata sandi diverifikasi) → OTP ke alamat **terdaftar**, bukan ke layar peminta → verifikasi → persetujuan Admin. Dua gerbang independen; OTP tidak pernah ada di respons API. |
| **Keadaan runtime dibagi antar-proses** | Penghitung batas laju dan respons idempoten ada di tabel, bukan memori. Passenger menjalankan beberapa proses dan me-recycle saat idle; keadaan di memori membuat batas "10/menit" menjadi 10 × jumlah proses lalu hilang. |
| **Batas masukan tidak tepercaya** (7) | Panjang User-Agent, daftar font, pertanyaan AI, dan formula KPI dibatasi sebelum menyentuh regex. Di shared hosting CPU adalah kuota: satu permintaan yang memaksa penelusuran ulang polinomial dapat menghabiskan jatah seluruh situs. |

Dokumen juga menuntut kejujuran: *device fingerprint adalah pengendali komersial, bukan
kontrol keamanan yang kuat* — karena itu ia tidak pernah menggantikan autentikasi, MFA, atau RBAC.

Temuan SAST yang **tidak** diperbaiki dicatat beserta alasannya di
**[docs/SAST-TRIAGE.md](docs/SAST-TRIAGE.md)** — termasuk apa yang akan mengubah keputusan
itu. Tidak ada aturan CodeQL yang disenyapkan: menyenyapkan aturan juga menyembunyikan
pelanggaran baru di masa depan.

---

## Pengujian

381 test, mengikuti TESTING.md. Penamaan `TC-XX-NN` mengikuti pola Bagian 3.

| Berkas | Cakupan |
|---|---|
| `tests/security.test.ts` | Isolasi tenant (**memblokir rilis**), matriks negatif RBAC, RLS, immutability audit |
| `tests/modules.test.ts` | TC-DS-01…08 dari PRD 6.11, DQ proporsi persis, koneksi, KPI, alert, embed, device, twin, kuota |
| `tests/stats.test.ts` | Nilai rujukan distribusi & uji statistik; determinisme |
| `tests/i18n.test.ts` | Paritas kunci ID/EN, nama modul tidak diterjemahkan, token Light/Dark |
| `tests/api.e2e.test.ts` | Alur E2E lintas modul lewat HTTP, isolasi tenant di lapisan API, validasi permintaan, dan proteksi lintasan berkas saat frontend disajikan |
| `tests/sqlite.test.ts` | Kesetaraan **kedua** driver SQLite — jalur `node:sqlite` yang dipakai shared hosting tidak boleh berperilaku berbeda dari `better-sqlite3` |
| `tests/billing.test.ts` | Arah upgrade/downgrade, pro-rata, kuota terlampaui, verifikasi tanda tangan webhook, dan penurunan akses bertahap akibat tunggakan |
| `tests/mfa.test.ts` | Vektor uji **resmi RFC 6238**, anti-replay, kode pemulihan sekali pakai, tantangan terikat perangkat, dan penegakan `mfaRequired` per peran |
| `tests/device-transfer.test.ts` | Perjalanan lengkap terkunci → pulih → masuk kembali, dan bahwa jalur pemulihan bukan jalan pintas melewati device binding |
| `tests/scheduler.test.ts` | Klaim pekerjaan (tidak berjalan dua kali), ketahanan saat satu tenant gagal, dan kewenangan sempit aktor sistem |
| `tests/stats-service.test.ts` | Cache hasil analisis **tidak menyeberangi cakupan RLS**, penolakan spesifikasi salah bentuk sebagai 400, dan transparansi metode (n setelah listwise deletion) |
| `tests/presentation.test.ts` | Angka korporat memakai agregat lintas dimensi, tren tidak mencampur dimensi, cakupan per divisi, dan penegakan baca-saja pada Balanced Scorecard |

Uji komponen/DOM web app berada di `frontend/web-app/tests/` (proyek vitest tersendiri,
karena butuh jsdom sedangkan tsconfig `services/` sengaja tanpa `lib: DOM`):

| Berkas | Cakupan |
|---|---|
| `tests/login.test.tsx` | Alur masuk dua langkah: formulir berganti saat faktor kedua diminta, tantangan mati mengembalikan pengguna ke langkah kata sandi, alasan **dan** langkah pemulihan keduanya tampil, kirim ganda dicegah |
| `tests/mfa-panel.test.tsx` | Kode pemulihan tampil sekali disertai peringatannya, rahasia tidak hilang setelah satu kode salah, tombol matikan disembunyikan untuk peran yang mewajibkan MFA |
| `tests/fingerprint.test.tsx` | Peramban yang memblokir kanvas demi privasi tidak menggagalkan login |

Cakupan backend saat ini: **85,8% baris / 85,7% fungsi / 68,1% branch**. Ambang ditegakkan
di `vitest.config.ts` dan memblokir merge bila turun.

---

## Desain

Seluruh warna, tipografi, dan spacing lewat token di `shared/design-tokens` — tidak ada
hex/px hardcode di komponen (TASK_INSTRUCTION.md Bagian 7). Yang dipatuhi dari DESIGN.md:

- **Threshold Ring** sebagai elemen tanda tangan, dipakai konsisten di Cockpit, KPI Center, Digital Twin.
- **Dark/Light Mode** dengan pengecualian yang disengaja: sidebar, banner AI, dan kertas
  Report Designer tidak ikut berbalik (Bagian 7.3).
- **ID/EN** lewat kamus `namespace.key`; nama modul tidak diterjemahkan, nama domain diterjemahkan.
- **Log Aktivitas** selalu memakai waktu ISO 8601 tak ambigu, apa pun locale Auditor (Bagian 8.3).
- **Aksesibilitas**: status tidak pernah lewat warna saja, fokus keyboard terlihat,
  target sentuh ≥ 32px, `prefers-reduced-motion` dihormati.
- **Label tidak berlebar tetap** — teks Indonesia 15–25% lebih panjang dari padanan Inggrisnya.

---

## Lisensi & atribusi

Nama kerja produk "Vantik" mengikuti catatan BRAND.md Bagian 1: ganti seluruh referensi bila
nama resmi sudah ditetapkan organisasi.
