/**
 * Jembatan MQTT → Vantik Analytics.
 *
 * Proses TERPISAH, dan itu bukan pilihan gaya. Aplikasi utamanya berjalan di bawah
 * Passenger, yang mematikan proses saat idle dan menyalakannya kembali saat ada
 * permintaan HTTP masuk. Koneksi MQTT harus HIDUP TERUS untuk menerima apa pun; klien
 * MQTT di dalam aplikasi akan mati bersama prosesnya dan diam-diam berhenti menerima
 * data sensor — tampak berjalan, tidak menerima apa-apa. Karena itu jembatannya berdiri
 * sendiri: dijalankan di mesin yang memang selalu menyala (mini PC di lokasi, VPS kecil,
 * atau Raspberry Pi), lalu mengirim ke API lewat HTTPS.
 *
 * Tanpa dependensi. Cukup Node.js 20+.
 *
 *   node bridge.js --config bridge.config.json
 *
 * Berhenti dengan Ctrl-C; kelompok pembacaan yang belum terkirim dikirim lebih dulu.
 */
'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { MqttClient, topicMatches } = require('./mqtt.js');

/* ================= Konfigurasi ================= */

function loadConfig() {
  const index = process.argv.indexOf('--config');
  const path = index >= 0 ? process.argv[index + 1] : 'bridge.config.json';
  const raw = readFileSync(resolve(process.cwd(), path), 'utf8');
  const config = JSON.parse(raw);

  const missing = ['broker', 'vantik', 'mappings'].filter((key) => !config[key]);
  if (missing.length > 0) throw new Error(`konfigurasi kurang: ${missing.join(', ')}`);
  if (!config.vantik.baseUrl || !config.vantik.ingestToken) {
    throw new Error('konfigurasi kurang: vantik.baseUrl dan vantik.ingestToken wajib diisi');
  }
  if (!Array.isArray(config.mappings) || config.mappings.length === 0) {
    throw new Error('konfigurasi kurang: mappings kosong — tidak ada topik yang akan didengarkan');
  }
  return config;
}

/* ================= Pemetaan topik → pembacaan ================= */

/**
 * Mengambil nilai dari muatan pesan.
 *
 * Muatan MQTT tidak punya bentuk baku. Tiga bentuk yang benar-benar sering ditemui
 * ditangani di sini; sisanya berarti mengubah firmware, dan itu bukan pekerjaan jembatan.
 */
function readValue(payload, mapping) {
  const text = payload.toString('utf8').trim();

  /**
   * Muatan kosong bukan nol.
   *
   * Broker mengirim PUBLISH bermuatan kosong untuk MENGHAPUS retained message pada sebuah
   * topik. `Number('')` bernilai 0, jadi tanpa penjagaan ini setiap penghapusan retained
   * message akan tercatat sebagai pembacaan bernilai nol — angka yang tidak pernah diukur
   * siapa pun, tepat pada saat sebuah sensor dinonaktifkan.
   */
  if (text === '') return null;

  // 1. Angka telanjang: "23.4"
  if (!mapping.valuePath) {
    const direct = Number(text);
    if (Number.isFinite(direct)) return { value: direct, observedAt: null };
  }

  // 2. JSON, dengan lintasan yang dapat ditentukan: {"data":{"temp":23.4,"ts":"..."}}
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 3. Bukan JSON dan bukan angka — dilaporkan, tidak didiamkan. Pesan yang dibuang
    //    tanpa jejak adalah cara data sensor menghilang tanpa ada yang tahu.
    return null;
  }

  const value = Number(pluck(parsed, mapping.valuePath ?? 'value'));
  if (!Number.isFinite(value)) return null;

  const observedAt = mapping.timePath ? pluck(parsed, mapping.timePath) : null;
  return { value, observedAt: normaliseTime(observedAt) };
}

/** Lintasan bertitik, mis. `data.temperature`. Tanpa evaluasi apa pun. */
function pluck(object, path) {
  return String(path)
    .split('.')
    .reduce((current, key) => (current == null ? undefined : current[key]), object);
}

/**
 * Waktu pengamatan dari perangkat.
 *
 * Menerima ISO 8601 maupun epoch (detik atau milidetik) — firmware memakai keduanya.
 * Yang tidak dapat dibaca dikembalikan `null`, sehingga server memakai waktu terimanya;
 * pembacaan dengan tanggal karangan lebih buruk daripada pembacaan tanpa tanggal.
 */
function normaliseTime(raw) {
  if (raw == null || raw === '') return null;

  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const number = Number(raw);
    // Epoch detik sampai sekitar tahun 2286; di atas itu pasti milidetik.
    const ms = number > 9_999_999_999 ? number : number * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Mengambil kode aset & sensor dari topik.
 *
 * Pola memakai penanda `{asset}` dan `{sensor}` pada tingkat topik, mis.
 * `pabrik/{asset}/{sensor}` cocok dengan `pabrik/PUMP-1/vibration`. Bila polanya tidak
 * memuat penanda, nilai tetap dari mapping (`assetCode`/`sensorCode`) yang dipakai.
 */
function resolveCodes(topic, mapping) {
  const codes = { assetCode: mapping.assetCode ?? '', sensorCode: mapping.sensorCode ?? '' };
  if (!mapping.topic.includes('{')) return codes;

  const patternParts = mapping.topic.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '{asset}') codes.assetCode = topicParts[i] ?? '';
    else if (patternParts[i] === '{sensor}') codes.sensorCode = topicParts[i] ?? '';
  }
  return codes;
}

/** Pola dengan penanda diubah menjadi filter MQTT yang sah (`+` per tingkat). */
function subscriptionFilter(pattern) {
  return pattern
    .split('/')
    .map((part) => (part.startsWith('{') && part.endsWith('}') ? '+' : part))
    .join('/');
}

/* ================= Antrean & pengiriman ================= */

class Forwarder {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.queue = [];
    this.sending = false;
    this.batchSize = config.vantik.batchSize ?? 100;
    this.flushMs = config.vantik.flushIntervalMs ?? 2000;
    /**
     * Batas antrean.
     *
     * Bila API tidak dapat dihubungi selama satu jam, antrean di memori akan tumbuh sampai
     * prosesnya mati kehabisan memori — dan yang hilang bukan hanya pembacaan baru,
     * melainkan seluruh isinya. Membuang yang TERLAMA saat penuh membuat kerugiannya
     * terbatas dan dapat diketahui.
     */
    this.maxQueue = config.vantik.maxQueue ?? 10_000;
    this.dropped = 0;
  }

  push(reading) {
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped++;
      // Dilaporkan berkala, bukan per pembacaan: satu baris log per pesan yang dibuang
      // akan menenggelamkan log justru saat ada yang tidak beres.
      if (this.dropped % 1000 === 1) {
        this.log(`antrean penuh (${this.maxQueue}); ${this.dropped} pembacaan terlama dibuang`);
      }
    }
    this.queue.push(reading);
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  start() {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async flush() {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;

    const batch = this.queue.slice(0, this.batchSize);
    try {
      const response = await fetch(`${this.config.vantik.baseUrl.replace(/\/$/, '')}/ingest/v1/twin/readings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vantik-Ingest-Token': this.config.vantik.ingestToken,
        },
        body: JSON.stringify({ readings: batch }),
        signal: AbortSignal.timeout(this.config.vantik.timeoutMs ?? 15_000),
      });

      if (response.status === 403) {
        // Token dicabut atau salah. Mencoba lagi selamanya hanya akan membanjiri log;
        // ini menuntut orang, bukan waktu.
        this.log('token ingest DITOLAK (403) — periksa vantik.ingestToken; jembatan berhenti');
        process.exitCode = 1;
        this.stop();
        return;
      }

      if (!response.ok) {
        // 429 dan 5xx bersifat sementara: kelompoknya DIPERTAHANKAN di antrean.
        this.log(`pengiriman gagal (HTTP ${response.status}); ${this.queue.length} pembacaan menunggu`);
        return;
      }

      const body = await response.json().catch(() => ({}));
      this.queue = this.queue.slice(batch.length);

      // Pembacaan yang ditolak server TIDAK dikirim ulang: alasannya menetap (aset atau
      // sensor tidak terdaftar), dan mengirim ulang hanya menghasilkan penolakan yang sama
      // selamanya. Dilaporkan supaya ada yang mendaftarkan asetnya.
      if (Array.isArray(body.rejected) && body.rejected.length > 0) {
        const sample = body.rejected
          .slice(0, 3)
          .map((r) => `${r.assetCode}/${r.sensorCode}: ${r.reason}`)
          .join('; ');
        this.log(`${body.rejected.length} pembacaan ditolak — ${sample}`);
      }
    } catch (error) {
      this.log(`pengiriman gagal: ${error.message}; ${this.queue.length} pembacaan menunggu`);
    } finally {
      this.sending = false;
    }
  }
}

/* ================= Jalannya proses ================= */

function main() {
  const config = loadConfig();
  const log = (message) => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);

  const forwarder = new Forwarder(config, log);
  forwarder.start();

  let attempt = 0;
  let stopping = false;
  let client = null;

  const connect = () => {
    client = new MqttClient({
      host: config.broker.host,
      port: config.broker.port ?? (config.broker.tls ? 8883 : 1883),
      tls: config.broker.tls === true,
      rejectUnauthorized: config.broker.rejectUnauthorized !== false,
      clientId: config.broker.clientId ?? `vantik-bridge-${process.pid}`,
      username: config.broker.username,
      password: config.broker.password,
      keepAliveSeconds: config.broker.keepAliveSeconds ?? 60,
    });

    client.on('connect', () => {
      attempt = 0;
      const filters = [...new Set(config.mappings.map((m) => subscriptionFilter(m.topic)))];
      client.subscribe(filters, config.broker.qos ?? 1);
      log(`tersambung ke ${config.broker.host}; berlangganan ${filters.length} pola topik`);
    });

    client.on('message', ({ topic, payload }) => {
      const mapping = config.mappings.find((m) => topicMatches(subscriptionFilter(m.topic), topic));
      if (!mapping) return;

      const parsed = readValue(payload, mapping);
      if (!parsed) {
        log(`muatan tidak terbaca pada ${topic}`);
        return;
      }

      const { assetCode, sensorCode } = resolveCodes(topic, mapping);
      if (!assetCode || !sensorCode) {
        log(`kode aset/sensor tidak lengkap untuk ${topic}`);
        return;
      }

      forwarder.push({
        assetCode,
        sensorCode,
        value: parsed.value,
        ...(parsed.observedAt ? { observedAt: parsed.observedAt } : {}),
      });
    });

    client.on('error', (error) => log(`kesalahan MQTT: ${error.message}`));

    client.on('close', () => {
      if (stopping) return;
      /**
       * Mundur bertahap, dengan batas.
       *
       * Broker yang mati dan jembatan yang menyambung ulang setiap detik adalah cara
       * membuat pemulihan lebih lambat. Batas atasnya tetap satu menit supaya jembatan
       * kembali sendiri tanpa perlu ada orang datang.
       */
      attempt++;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
      log(`koneksi terputus; menyambung ulang dalam ${Math.round(delay / 1000)} detik`);
      setTimeout(connect, delay).unref?.();
    });

    client.connect();
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log('berhenti; mengirim sisa antrean');
    client?.end();
    void forwarder.flush().finally(() => {
      forwarder.stop();
      process.exit(process.exitCode ?? 0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  connect();
}

if (require.main === module) main();

module.exports = { readValue, resolveCodes, subscriptionFilter, normaliseTime, pluck, Forwarder };
