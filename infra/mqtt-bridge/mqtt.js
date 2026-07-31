/**
 * Klien MQTT 3.1.1 secukupnya — hanya yang dibutuhkan sebuah jembatan pembaca.
 *
 * Ditulis sendiri, tanpa dependensi, dengan alasan yang sama seperti sisa proyek ini:
 * jembatannya sering dijalankan di mesin kecil di lantai pabrik atau di shared hosting
 * yang tidak dapat mengompilasi modul native, dan satu `npm install` yang gagal di sana
 * berarti data sensor berhenti mengalir sampai ada orang datang.
 *
 * Yang DIDUKUNG: CONNECT (dengan username/password dan clean session), SUBSCRIBE pada
 * QoS 0 dan 1, penerimaan PUBLISH beserta PUBACK-nya, PINGREQ/PINGRESP, dan DISCONNECT.
 *
 * Yang TIDAK: penerbitan pesan, QoS 2, retained message di sisi kirim, dan will message.
 * Jembatan ini hanya mendengarkan; menuliskan setengah dari fitur yang tidak dipakai
 * hanya menambah kode yang tidak pernah dijalankan siapa pun.
 *
 * Protokol: MQTT Version 3.1.1, OASIS Standard.
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

/* Jenis paket kontrol (MQTT 3.1.1 §2.2.1). */
const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

/** Alasan penolakan CONNACK (§3.2.2.3), diterjemahkan agar log dapat ditindaklanjuti. */
const CONNACK_REASONS = {
  1: 'versi protokol tidak diterima broker',
  2: 'client id ditolak',
  3: 'broker sedang tidak tersedia',
  4: 'nama pengguna atau kata sandi salah',
  5: 'tidak berwenang',
};

/**
 * Panjang sisa dikodekan 1–4 byte, tujuh bit per byte (§2.2.3).
 *
 * Inilah bagian yang paling sering salah pada implementasi buatan sendiri, dan salahnya
 * tidak terlihat sampai ada pesan yang lebih panjang dari 127 byte.
 */
function encodeLength(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

/** Mengembalikan `null` bila byte panjangnya belum lengkap di dalam buffer. */
function decodeLength(buffer, offset) {
  let multiplier = 1;
  let value = 0;
  let index = offset;

  for (let i = 0; i < 4; i++) {
    if (index >= buffer.length) return null;
    const byte = buffer[index++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, bytes: index - offset };
    multiplier *= 128;
  }
  throw new Error('mqtt_malformed_length');
}

/** String UTF-8 berawalan panjang 2 byte (§1.5.3). */
function encodeString(value) {
  const payload = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function packet(type, flags, payload) {
  const fixed = Buffer.from([(type << 4) | flags]);
  return Buffer.concat([fixed, encodeLength(payload.length), payload]);
}

/**
 * Apakah topik cocok dengan filter berjoker.
 *
 * `+` cocok dengan tepat satu tingkat, `#` dengan sisa tingkat berapa pun. Dipakai untuk
 * memetakan pesan ke aturan, bukan untuk memutuskan langganan — broker yang memutuskan
 * apa yang dikirim.
 */
function topicMatches(filter, topic) {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < filterParts.length; i++) {
    if (filterParts[i] === '#') return true;
    if (i >= topicParts.length) return false;
    if (filterParts[i] !== '+' && filterParts[i] !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}

/**
 * Klien MQTT.
 *
 * Peristiwa: `connect`, `message` ({ topic, payload }), `error`, `close`.
 * Penyambungan ulang BUKAN urusan kelas ini — pemanggil yang mengaturnya, supaya
 * kebijakan tunggu dan batas percobaan berada di satu tempat yang terbaca.
 */
class MqttClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.buffer = Buffer.alloc(0);
    this.nextPacketId = 1;
    this.socket = null;
    this.pingTimer = null;
    this.connectTimer = null;
  }

  connect() {
    const { host, port, tls: useTls, rejectUnauthorized } = this.options;
    const onReady = () => this.sendConnect();

    this.socket = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: rejectUnauthorized !== false }, onReady)
      : net.connect({ host, port }, onReady);

    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => this.emit('error', error));
    this.socket.on('close', () => {
      this.stopTimers();
      this.emit('close');
    });

    /**
     * Broker yang menerima koneksi TCP tetapi tidak pernah menjawab CONNACK akan membuat
     * jembatan menggantung selamanya — tanpa kesalahan, tanpa data. Batas waktu ini yang
     * mengubahnya menjadi kegagalan yang terlihat dan dapat dicoba ulang.
     */
    this.connectTimer = setTimeout(() => {
      this.emit('error', new Error('mqtt_connack_timeout'));
      this.destroy();
    }, 20_000);
    this.connectTimer.unref?.();
  }

  sendConnect() {
    const { clientId, username, password, keepAliveSeconds } = this.options;
    const keepAlive = keepAliveSeconds ?? 60;

    let flags = 0x02; // clean session
    if (username) flags |= 0x80;
    if (username && password) flags |= 0x40;

    const variable = Buffer.concat([
      encodeString('MQTT'),
      Buffer.from([4, flags]), // level 4 = MQTT 3.1.1
      (() => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(keepAlive, 0);
        return buf;
      })(),
    ]);

    const payload = [encodeString(clientId)];
    if (username) payload.push(encodeString(username));
    if (username && password) payload.push(encodeString(password));

    this.write(packet(CONNECT, 0, Buffer.concat([variable, ...payload])));

    if (keepAlive > 0) {
      // Setengah dari keep-alive: broker memutus koneksi pada 1,5× nilai itu, jadi satu
      // PINGREQ yang hilang tidak boleh langsung berarti terputus.
      this.pingTimer = setInterval(() => this.write(packet(PINGREQ, 0, Buffer.alloc(0))), (keepAlive * 1000) / 2);
      this.pingTimer.unref?.();
    }
  }

  /** Berlangganan beberapa filter sekaligus; satu paket, satu SUBACK. */
  subscribe(filters, qos = 1) {
    const id = this.takePacketId();
    const header = Buffer.alloc(2);
    header.writeUInt16BE(id, 0);

    const entries = filters.map((filter) => Buffer.concat([encodeString(filter), Buffer.from([qos])]));
    // Bit 1 pada flags wajib bernilai 1 untuk SUBSCRIBE (§3.8.1).
    this.write(packet(SUBSCRIBE, 0x02, Buffer.concat([header, ...entries])));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Satu pembacaan soket dapat memuat beberapa paket, atau sepotong paket. Keduanya
    // normal pada TCP; memperlakukan satu chunk sebagai satu paket adalah kekeliruan yang
    // baru muncul saat lalu lintas ramai.
    for (;;) {
      if (this.buffer.length < 2) return;

      const header = this.buffer[0];
      const length = decodeLength(this.buffer, 1);
      if (!length) return;

      const total = 1 + length.bytes + length.value;
      if (this.buffer.length < total) return;

      const body = this.buffer.subarray(1 + length.bytes, total);
      this.buffer = this.buffer.subarray(total);
      this.handlePacket(header >> 4, header & 0x0f, body);
    }
  }

  handlePacket(type, flags, body) {
    switch (type) {
      case CONNACK: {
        clearTimeout(this.connectTimer);
        const code = body[1];
        if (code !== 0) {
          this.emit('error', new Error(`mqtt_connect_refused: ${CONNACK_REASONS[code] ?? `kode ${code}`}`));
          this.destroy();
          return;
        }
        this.emit('connect');
        return;
      }

      case PUBLISH: {
        const qos = (flags >> 1) & 0x03;
        const topicLength = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + topicLength).toString('utf8');

        let offset = 2 + topicLength;
        let packetId = null;
        if (qos > 0) {
          packetId = body.readUInt16BE(offset);
          offset += 2;
        }

        const payload = body.subarray(offset);
        // PUBACK dikirim SEBELUM pesannya diproses. Broker menahan pesan yang belum
        // diakui, dan pemrosesan yang lambat pada QoS 1 berarti broker mengirim ulang
        // pesan yang sama — menggandakan pembacaan, bukan menyelamatkannya.
        if (qos === 1 && packetId !== null) {
          const ack = Buffer.alloc(2);
          ack.writeUInt16BE(packetId, 0);
          this.write(packet(PUBACK, 0, ack));
        }
        this.emit('message', { topic, payload });
        return;
      }

      case SUBACK: {
        // 0x80 pada kode kembali berarti broker MENOLAK filternya (§3.9.3). Tanpa
        // pemeriksaan ini, jembatan tampak berjalan normal sambil tidak menerima apa pun.
        const codes = [...body.subarray(2)];
        if (codes.some((code) => code === 0x80)) {
          this.emit('error', new Error('mqtt_subscribe_refused'));
        }
        return;
      }

      case PINGRESP:
      case PUBACK:
        return;

      default:
        return;
    }
  }

  write(buffer) {
    if (this.socket && !this.socket.destroyed) this.socket.write(buffer);
  }

  takePacketId() {
    const id = this.nextPacketId;
    // Nol bukan id yang sah (§2.3.1); pembungkusannya melewatinya.
    this.nextPacketId = this.nextPacketId >= 0xffff ? 1 : this.nextPacketId + 1;
    return id;
  }

  stopTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.connectTimer);
    this.pingTimer = null;
    this.connectTimer = null;
  }

  end() {
    this.write(packet(DISCONNECT, 0, Buffer.alloc(0)));
    this.destroy();
  }

  destroy() {
    this.stopTimers();
    this.socket?.destroy();
  }
}

module.exports = { MqttClient, topicMatches, encodeLength, decodeLength, encodeString, packet };
