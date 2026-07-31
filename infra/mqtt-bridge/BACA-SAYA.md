# Jembatan MQTT → Vantik Analytics

Menyambungkan broker MQTT ke Digital Twin: berlangganan topik sensor, lalu mengirim
pembacaannya ke API.

## Mengapa proses terpisah

Aplikasi utama berjalan di bawah Passenger, yang **mematikan proses saat idle** dan
menyalakannya kembali ketika ada permintaan HTTP masuk. Koneksi MQTT harus hidup terus
untuk menerima apa pun — klien MQTT di dalam aplikasi akan mati bersama prosesnya dan
diam-diam berhenti menerima data sensor. Yang terlihat: aplikasi berjalan normal, data
sensor berhenti bertambah, dan tidak ada pesan kesalahan di mana pun.

Karena itu jembatan berdiri sendiri, dijalankan di mesin yang memang selalu menyala:
mini PC di lokasi, VPS kecil, atau Raspberry Pi. Ia berbicara MQTT ke dalam jaringan dan
HTTPS ke luar — jadi tidak ada port yang perlu dibuka dari internet ke lantai pabrik.

```
sensor → broker MQTT → [jembatan] → HTTPS → Vantik Analytics
```

## Prasyarat

- Node.js 20 atau lebih baru. **Tanpa dependensi** — tidak ada `npm install`.
- Akses jaringan ke broker MQTT dan ke alamat aplikasi.

## Langkah pasang

### 1. Daftarkan asetnya lebih dulu

Jembatan tidak membuat aset. Buat aset dan sensornya di **Digital Twin** dengan kode yang
sama persis dengan yang akan dikirim jembatan. Pembacaan untuk aset atau sensor yang belum
terdaftar akan ditolak — dan alasannya tercetak di log jembatan, jadi kekeliruan kode
mudah dikenali.

### 2. Terbitkan token ingest

Di aplikasi, sebagai **System Admin** atau **Super Admin**:

```
POST /api/v1/twin/ingest-tokens     {"label": "Jembatan Pabrik 1"}
```

Nilai tokennya ada di jawaban permintaan itu dan **tidak pernah dapat dibaca lagi** —
yang tersimpan hanya hash-nya. Token yang hilang diganti dengan menerbitkan yang baru
lalu mencabut yang lama:

```
GET    /api/v1/twin/ingest-tokens         daftar (tanpa nilai token)
DELETE /api/v1/twin/ingest-tokens/:id     mencabut, berlaku seketika
```

Token terikat pada **satu ruang kerja** dan hanya membawa satu izin: mengirim pembacaan.
Ia tidak dapat membaca dasbor, melihat aset, atau membuat tiket. Jembatan yang diletakkan
di lantai pabrik adalah perangkat yang paling mudah diambil orang.

### 3. Salin dan isi konfigurasi

```bash
cp bridge.config.example.json bridge.config.json
```

| Bagian | Isi |
|---|---|
| `broker.host` / `port` | Alamat broker. Port 8883 untuk TLS, 1883 tanpa TLS |
| `broker.tls` | `true` bila broker memakai TLS. Sangat dianjurkan bila jembatan dan broker tidak satu jaringan |
| `broker.username` / `password` | Bila broker menuntutnya |
| `broker.clientId` | Harus **unik per jembatan**. Dua klien dengan id sama akan saling menendang, dan gejalanya adalah data yang putus-putus |
| `vantik.baseUrl` | Alamat aplikasi, mis. `https://analitik.contoh.id` |
| `vantik.ingestToken` | Token dari langkah 2 |
| `mappings` | Pemetaan topik → aset & sensor, lihat di bawah |

### 4. Jalankan

```bash
node bridge.js --config bridge.config.json
```

Agar tetap hidup setelah reboot, pasang sebagai layanan systemd:

```ini
# /etc/systemd/system/vantik-mqtt-bridge.service
[Unit]
Description=Jembatan MQTT Vantik Analytics
After=network-online.target

[Service]
Type=simple
User=vantik
WorkingDirectory=/opt/vantik-mqtt-bridge
ExecStart=/usr/bin/node bridge.js --config bridge.config.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now vantik-mqtt-bridge
sudo journalctl -u vantik-mqtt-bridge -f
```

## Pemetaan topik

Setiap entri `mappings` menyatakan topik mana yang didengarkan dan bagaimana isinya dibaca.

**Kode dari topik.** Penanda `{asset}` dan `{sensor}` mengambil satu tingkat topik:

```json
{ "topic": "pabrik/{asset}/{sensor}", "valuePath": "value", "timePath": "timestamp" }
```

`pabrik/PUMP-1/vibration` → aset `PUMP-1`, sensor `vibration`.

**Kode tetap.** Untuk topik yang tidak memuat kodenya:

```json
{ "topic": "gedung/lantai-2/suhu", "assetCode": "AC-1", "sensorCode": "temperature" }
```

**Campuran.** Joker MQTT `+` dan `#` tetap dapat dipakai bersama penanda:

```json
{ "topic": "iot/+/telemetri/{asset}", "sensorCode": "temperature", "valuePath": "d.t" }
```

### Bentuk muatan

Tiga bentuk yang ditangani:

| Muatan | Konfigurasi |
|---|---|
| `23.4` | tanpa `valuePath` |
| `{"value":23.4,"timestamp":1735689600}` | `"valuePath": "value"`, `"timePath": "timestamp"` |
| `{"d":{"t":23.4}}` | `"valuePath": "d.t"` |

`timePath` menerima ISO 8601 maupun epoch (detik atau milidetik). Waktu yang tidak dapat
dibaca diabaikan dan server memakai waktu terimanya — pembacaan bertanggal karangan lebih
buruk daripada pembacaan tanpa tanggal.

Muatan **kosong diabaikan**, bukan dibaca sebagai nol: broker mengirim pesan kosong untuk
menghapus retained message, dan itu bukan hasil pengukuran siapa pun.

## Yang terjadi saat ada gangguan

| Keadaan | Perilaku |
|---|---|
| Broker mati | Menyambung ulang dengan jeda bertambah, maksimum 1 menit. Kembali sendiri |
| API tidak dapat dihubungi | Pembacaan menunggu di antrean memori (bawaan 10.000) dan dikirim saat pulih |
| Antrean penuh | Yang **terlama** dibuang, dan pembuangannya dilaporkan di log |
| Token dicabut / salah (403) | Jembatan **berhenti**. Ini menuntut orang, bukan waktu |
| Aset/sensor belum terdaftar | Pembacaan itu ditolak dan dilaporkan; sisanya tetap masuk. Tidak dikirim ulang — alasannya menetap |
| Ruang kerja baca-saja | Ditolak, sama seperti penulisan lain. Jembatan bukan celah untuk melewati status langganan |

Antrean disimpan **di memori**, bukan di disk: jembatan yang dimatikan paksa kehilangan
apa yang belum terkirim. Menuliskannya ke disk berarti mengelola berkas yang tumbuh di
perangkat yang paling sedikit diawasi orang. Bila kehilangan itu tidak dapat diterima,
pakai broker yang menyimpan pesan (persistent session, QoS 1) dan biarkan broker yang
menahannya.

## Batas yang perlu diketahui

- **Hanya mendengarkan.** Jembatan tidak menerbitkan pesan ke broker dan tidak
  mengirimkan perintah ke perangkat.
- **QoS 0 dan 1.** QoS 2 tidak didukung; untuk telemetri, "sampai setidaknya sekali"
  sudah lebih dari cukup dan QoS 2 berlipat ganda percakapannya.
- **Satu ruang kerja per jembatan.** Token terikat pada satu tenant. Untuk beberapa ruang
  kerja, jalankan beberapa proses dengan berkas konfigurasi masing-masing.
