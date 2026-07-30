# Triase temuan SAST (CodeQL)

Berkas ini mencatat setiap temuan CodeQL yang **tidak** diperbaiki, beserta alasannya.

Alasan berkas ini ada: gerbang SAST hanya berguna bila setiap temuannya punya keputusan
yang dapat ditinjau. Temuan yang dibiarkan tanpa catatan akan berubah menjadi kebisingan,
dan gerbang yang berisik akhirnya diabaikan — kegagalan yang justru ingin dicegah
TESTING.md Bagian 10.

Temuan diringkas ke log job dan disimpan sebagai artefak `sast-sarif` oleh langkah
"Ringkas temuan SAST" di `.github/workflows/ci.yml`, sehingga daftarnya dapat dibaca tanpa
akses tab Security repositori.

**Tidak ada aturan yang disenyapkan lewat `query-filters`.** Menyenyapkan aturan akan
menyembunyikan juga pelanggaran BARU di masa depan — mis. rute baru yang benar-benar tanpa
batas laju. Lebih baik gerbangnya merah dengan alasan tertulis daripada hijau karena
aturannya dimatikan.

---

## Sudah diperbaiki (tidak lagi muncul)

| Aturan | Temuan | Perbaikan |
|---|---|---|
| `js/insecure-randomness` | 6 | OTP pemindahan perangkat memakai `randomInt`; bagian acak `newId()` memakai `randomBytes`. OTP adalah faktor autentikasi dan `Math.random()` dapat diprediksi. |
| `js/polynomial-redos` | 4 | Panjang User-Agent, daftar font, dan pertanyaan AI dibatasi sebelum menyentuh regex; formula KPI ditolak bila melebihi batas. |

Rinciannya ada di riwayat commit, bukan diringkas ulang di sini.

---

## Tidak diperbaiki, dengan alasan

### `js/missing-rate-limiting` — 3 temuan

**`services/src/app.ts` (`POST /api/v1/auth/reauthenticate` dan `POST /api/v1/me/password`)** — POSITIF PALSU.

Kedua rute ini **sudah** dibatasi laju, dua kali: seluruh router `/api` memakai
`apiLimiter` (600/menit), dan masing-masing handler menambahkan `loginLimiter` (10/menit,
berkunci pada userId) karena keduanya memeriksa kata sandi.

CodeQL menandai **baris tempat limiter itu dipasang**. Query `MissingRateLimiting.ql`
mengenali paket batas laju yang sudah dimodelkan (`express-rate-limit`, `express-brute`,
`rate-limiter-flexible`, dan beberapa lain), sedangkan kelas `RateLimiter` di
`services/src/platform/http.ts` dibuat sendiri agar paket runtime tetap minimal — syarat
praktis untuk shared hosting.

**Alasan ini dibuktikan uji, bukan sekadar dinyatakan.** `TC-PWD-15` menembak
`POST /me/password` empat belas kali dan menuntut sebagian dijawab `429`; `TC-RL-*` di
`security.test.ts` melakukan hal setara untuk jalur login. Bila limiter itu suatu saat
terlepas, yang gagal adalah uji — bukan alasan di dokumen ini yang diam-diam menjadi salah.

*Yang akan mengubah keputusan ini:* bila paket runtime tambahan menjadi dapat diterima,
mengganti `RateLimiter` dengan `express-rate-limit` akan sekaligus menghapus temuan ini dan
memberi implementasi yang lebih matang (jendela geser, bukan jendela tetap yang dapat
ditembus lonjakan di batas jendela). Itu keputusan dependensi, bukan keputusan keamanan,
jadi tidak diambil sepihak.

**`services/src/server.ts` (penyajian `index.html`)** — TIDAK AKAN DIPERBAIKI.

Yang disajikan adalah satu berkas HTML statis kecil, bukan operasi basis data. Membatasi
lajunya akan menghukum banyak pengguna sah yang berbagi satu IP publik di belakang NAT —
lazim di jaringan kantor dan sekolah, yang justru profil pengguna platform ini. Perlindungan
lapis infrastruktur (CDN/Apache) adalah tempat yang benar untuk ini.

### `js/missing-token-validation` — 1 temuan

**`services/src/app.ts` (`cookieParser()`)** — POSITIF PALSU sejak cookie dibatasi.

Query ini mencari middleware CSRF (mis. `csurf`) pada aplikasi yang memakai cookie sesi.
Tidak ada, dan tidak akan ditambahkan, karena kelas serangannya sudah dihapus dengan cara
lain: **cookie sesi hanya diterima untuk GET/HEAD/OPTIONS** (`authenticate()` di
`services/src/platform/http.ts`). Setiap permintaan yang menulis wajib membawa
`Authorization: Bearer`, dan peramban tidak dapat menambahkan header itu pada permintaan
lintas-situs tanpa lolos preflight CORS — sehingga formulir dari situs lain tidak punya
jalan untuk menulis. Cookie tetap `httpOnly`, `sameSite=lax`, dan `secure` di produksi.

Token CSRF di atas itu akan menjadi lapis tambahan tanpa kelas serangan baru yang ditutup,
dengan biaya satu perjalanan bolak-balik token di setiap sesi klien.

*Yang akan mengubah keputusan ini:* menerima cookie untuk metode yang menulis (mis. demi
klien non-JS atau unggahan berbasis formulir). Bila itu terjadi, token CSRF menjadi WAJIB,
bukan opsional.

### `js/loop-bound-injection` — 4 temuan

Keempatnya adalah loop yang batasnya berasal dari data pengguna, dan pada keempatnya
batas itu sudah ditegakkan **di hulu** sebelum mencapai loop:

| Lokasi | Batas di hulu |
|---|---|
| `ai-engine-service/index.ts` (`arimaLike`) | `horizon` divalidasi `1..36` di `ForecastService.run()`; panjang deret mengikuti jumlah baris dataset. |
| `identity-service/index.ts` (impor pegawai) | Jumlah baris CSV dibatasi kuota unggah paket (`error.upload_too_many_rows`) dan batas ukuran badan permintaan. |
| `identity-service/index.ts` (`splitCsvLine`) | Loop linier terhadap panjang satu baris; panjangnya terbatas oleh batas ukuran unggahan. |
| `stats-service/regression.ts` (`multiply`) | Dimensi matriks berasal dari jumlah prediktor dan baris dataset, keduanya terbatas skema dataset dan kuota unggah. |

*Yang akan mengubah keputusan ini:* menambah jalur yang memberi pengguna kendali langsung
atas ukuran iterasi tanpa validasi — mis. parameter `limit` atau `iterations` baru yang
diteruskan mentah ke perhitungan. Penambahan seperti itu wajib membawa validasi sendiri.

---

## Cara membaca temuan terbaru

1. Buka job **SAST** pada run CI terkait.
2. Baca langkah **"Ringkas temuan SAST"** — memuat aturan, jumlah, dan setiap `berkas:baris`.
3. Untuk rincian jalur data, unduh artefak **`sast-sarif`** dari run yang sama.
