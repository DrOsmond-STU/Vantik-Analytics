/**
 * Jembatan MQTT: pengodean protokol dan pemetaan topik.
 *
 * Jembatan berjalan sebagai proses terpisah di luar aplikasi — biasanya di mesin kecil di
 * lokasi, tanpa ada yang memperhatikannya. Kesalahan di sini tidak muncul sebagai error;
 * ia muncul sebagai data sensor yang diam-diam berhenti mengalir, atau lebih buruk,
 * sebagai angka yang salah masuk ke aset yang salah.
 *
 * Empat hal yang paling mudah salah pada klien MQTT buatan sendiri:
 *
 *  1. **Panjang sisa** (TC-MQB-01). Dikodekan tujuh bit per byte; salah sedikit dan pesan
 *     yang lebih panjang dari 127 byte merusak seluruh aliran setelahnya.
 *  2. **Batas paket di dalam aliran TCP** (TC-MQB-03). Satu pembacaan soket dapat memuat
 *     beberapa paket atau sepotong paket — keduanya normal.
 *  3. **Pencocokan joker** (TC-MQB-05). `+` satu tingkat, `#` sisanya.
 *  4. **Waktu dari perangkat** (TC-MQB-08). Firmware memakai epoch detik, epoch
 *     milidetik, dan ISO 8601 — ketiganya, kadang di pabrik yang sama.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'mqtt-bridge');

const { encodeLength, decodeLength, encodeString, packet, topicMatches, MqttClient } = require_(
  join(bridgeDir, 'mqtt.js'),
) as typeof import('../../infra/mqtt-bridge/mqtt.js');

const { readValue, resolveCodes, subscriptionFilter, normaliseTime, pluck } = require_(
  join(bridgeDir, 'bridge.js'),
) as typeof import('../../infra/mqtt-bridge/bridge.js');

/* ================= Protokol ================= */

describe('Pengodean MQTT 3.1.1', () => {
  it('TC-MQB-01 — panjang sisa dikodekan tujuh bit per byte', () => {
    // Nilai batas dari tabel §2.2.3 — inilah yang membedakan implementasi yang benar dari
    // yang "berjalan sampai ada pesan panjang".
    expect([...encodeLength(0)]).toEqual([0x00]);
    expect([...encodeLength(127)]).toEqual([0x7f]);
    expect([...encodeLength(128)]).toEqual([0x80, 0x01]);
    expect([...encodeLength(16_383)]).toEqual([0xff, 0x7f]);
    expect([...encodeLength(16_384)]).toEqual([0x80, 0x80, 0x01]);
    expect([...encodeLength(2_097_152)]).toEqual([0x80, 0x80, 0x80, 0x01]);
  });

  it('TC-MQB-02 — panjang yang dikodekan dapat dibaca kembali', () => {
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 2_097_151]) {
      const encoded = Buffer.concat([Buffer.from([0x30]), encodeLength(value)]);
      expect(decodeLength(encoded, 1), String(value)).toEqual({
        value,
        bytes: encodeLength(value).length,
      });
    }
    // Byte panjang yang belum lengkap → `null`, bukan tebakan.
    expect(decodeLength(Buffer.from([0x30, 0x80]), 1)).toBeNull();
  });

  it('TC-MQB-03 — beberapa paket dalam satu chunk, dan satu paket terbelah, sama-sama utuh', () => {
    const client = new MqttClient({ host: 'x', port: 1, clientId: 'uji' });
    const received: string[] = [];
    client.on('message', ({ topic, payload }) => received.push(`${topic}=${payload.toString('utf8')}`));

    const publish = (topic: string, body: string): Buffer =>
      packet(3, 0, Buffer.concat([encodeString(topic), Buffer.from(body, 'utf8')]));

    // Dua paket menempel dalam satu pembacaan soket.
    client.onData(Buffer.concat([publish('a/b', '1'), publish('c/d', '2')]));
    expect(received).toEqual(['a/b=1', 'c/d=2']);

    // Satu paket terbelah menjadi tiga potongan.
    const whole = publish('e/f', '3');
    client.onData(whole.subarray(0, 1));
    client.onData(whole.subarray(1, 4));
    expect(received).toHaveLength(2); // belum lengkap — belum boleh dipancarkan
    client.onData(whole.subarray(4));
    expect(received).toEqual(['a/b=1', 'c/d=2', 'e/f=3']);
  });

  it('TC-MQB-04 — PUBLISH QoS 1 dijawab PUBACK dengan id paket yang sama', () => {
    const client = new MqttClient({ host: 'x', port: 1, clientId: 'uji' });
    const written: Buffer[] = [];
    client.write = (buffer: Buffer) => void written.push(buffer);

    const id = Buffer.alloc(2);
    id.writeUInt16BE(0x1234, 0);
    const body = Buffer.concat([encodeString('a/b'), id, Buffer.from('9.5')]);
    // flags 0x02 = QoS 1
    client.onData(packet(3, 0x02, body));

    expect(written).toHaveLength(1);
    const puback = written[0]!;
    // Tanpa PUBACK, broker mengirim ulang pesan yang sama selamanya — pembacaan
    // berlipat, bukan hilang.
    expect(puback[0]! >> 4).toBe(4); // PUBACK
    expect(puback.readUInt16BE(2)).toBe(0x1234);
  });

  it('TC-MQB-05 — joker cocok per tingkat, bukan per karakter', () => {
    expect(topicMatches('pabrik/+/getaran', 'pabrik/pompa-1/getaran')).toBe(true);
    // `+` adalah SATU tingkat, bukan "apa saja".
    expect(topicMatches('pabrik/+/getaran', 'pabrik/lantai-1/pompa-1/getaran')).toBe(false);
    expect(topicMatches('pabrik/#', 'pabrik/lantai-1/pompa-1/getaran')).toBe(true);
    expect(topicMatches('pabrik/a', 'pabrik/a/b')).toBe(false);
    expect(topicMatches('pabrik/a/b', 'pabrik/a')).toBe(false);
    expect(topicMatches('pabrik/a', 'gudang/a')).toBe(false);
  });
});

/* ================= Pemetaan ================= */

describe('Pemetaan topik menjadi pembacaan', () => {
  it('TC-MQB-06 — kode aset & sensor diambil dari tingkat topik', () => {
    const mapping = { topic: 'pabrik/{asset}/{sensor}' };

    expect(resolveCodes('pabrik/PUMP-1/vibration', mapping)).toEqual({
      assetCode: 'PUMP-1',
      sensorCode: 'vibration',
    });

    // Campuran: aset dari topik, sensor dari nilai tetap.
    expect(resolveCodes('iot/gw-9/telemetri/PUMP-2', { topic: 'iot/+/telemetri/{asset}', sensorCode: 'temperature' })).toEqual(
      { assetCode: 'PUMP-2', sensorCode: 'temperature' },
    );

    // Tanpa penanda: keduanya dari nilai tetap.
    expect(resolveCodes('gedung/suhu', { topic: 'gedung/suhu', assetCode: 'AC-1', sensorCode: 'temperature' })).toEqual({
      assetCode: 'AC-1',
      sensorCode: 'temperature',
    });
  });

  it('TC-MQB-07 — pola dengan penanda menjadi filter MQTT yang sah', () => {
    // Penanda `{asset}` bukan sintaks MQTT; broker akan menolak langganannya apa adanya.
    expect(subscriptionFilter('pabrik/{asset}/{sensor}')).toBe('pabrik/+/+');
    expect(subscriptionFilter('iot/+/telemetri/{asset}')).toBe('iot/+/telemetri/+');
    expect(subscriptionFilter('gedung/lantai-2/suhu')).toBe('gedung/lantai-2/suhu');
  });

  it('TC-MQB-08 — waktu dari perangkat: epoch detik, epoch milidetik, dan ISO', () => {
    // Ketiganya dipakai firmware yang berbeda, kadang di pabrik yang sama.
    expect(normaliseTime(1_735_689_600)).toBe('2025-01-01T00:00:00.000Z');
    expect(normaliseTime(1_735_689_600_000)).toBe('2025-01-01T00:00:00.000Z');
    expect(normaliseTime('2025-01-01T00:00:00Z')).toBe('2025-01-01T00:00:00.000Z');
    expect(normaliseTime('1735689600')).toBe('2025-01-01T00:00:00.000Z');

    // Yang tidak terbaca menjadi `null`, sehingga server memakai waktu terimanya.
    // Pembacaan bertanggal karangan lebih buruk daripada pembacaan tanpa tanggal.
    expect(normaliseTime('kemarin sore')).toBeNull();
    expect(normaliseTime(null)).toBeNull();
    expect(normaliseTime('')).toBeNull();
  });

  it('TC-MQB-09 — tiga bentuk muatan yang benar-benar ditemui', () => {
    // Angka telanjang.
    expect(readValue(Buffer.from('23.4'), {})).toEqual({ value: 23.4, observedAt: null });

    // JSON datar.
    expect(readValue(Buffer.from('{"value":4.2,"timestamp":1735689600}'), { valuePath: 'value', timePath: 'timestamp' })).toEqual(
      { value: 4.2, observedAt: '2025-01-01T00:00:00.000Z' },
    );

    // JSON bersarang.
    expect(readValue(Buffer.from('{"d":{"t":19.75}}'), { valuePath: 'd.t' })).toEqual({
      value: 19.75,
      observedAt: null,
    });
  });

  it('TC-MQB-10 — muatan yang tidak terbaca menjadi null, bukan NaN yang tersimpan', () => {
    // NaN yang lolos ke basis data adalah pembacaan yang merusak skor kesehatan aset dan
    // tidak dapat ditelusuri kembali ke pesan asalnya.
    expect(readValue(Buffer.from('ON'), {})).toBeNull();
    expect(readValue(Buffer.from(''), {})).toBeNull();
    expect(readValue(Buffer.from('{"value":"panas"}'), { valuePath: 'value' })).toBeNull();
    expect(readValue(Buffer.from('{rusak'), { valuePath: 'value' })).toBeNull();
    // Lintasan yang menunjuk ke tempat kosong juga.
    expect(readValue(Buffer.from('{"a":1}'), { valuePath: 'b.c.d' })).toBeNull();
  });

  it('TC-MQB-11 — lintasan bertitik tidak mengevaluasi apa pun', () => {
    // Lintasan berasal dari berkas konfigurasi, tetapi bentuknya mengundang orang menulis
    // sesuatu yang lebih pintar. Ini pembacaan properti biasa, bukan ekspresi.
    expect(pluck({ a: { b: 7 } }, 'a.b')).toBe(7);
    expect(pluck({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(pluck({}, 'constructor.name')).toBe('Object');
  });
});

/* ================= Antrean ================= */

describe('Antrean pengiriman', () => {
  it('TC-MQB-12 — antrean penuh membuang yang TERLAMA, bukan berhenti menerima', async () => {
    const { Forwarder } = require_(join(bridgeDir, 'bridge.js')) as typeof import('../../infra/mqtt-bridge/bridge.js');
    const messages: string[] = [];
    const forwarder = new Forwarder(
      { vantik: { baseUrl: 'http://x', ingestToken: 't', maxQueue: 3, batchSize: 1000 } },
      (m: string) => messages.push(m),
    );

    for (let i = 0; i < 6; i++) forwarder.push({ assetCode: 'A', sensorCode: 's', value: i });

    // Batasnya dihormati, dan yang tersisa adalah yang TERBARU: saat API tidak dapat
    // dihubungi berjam-jam, pembacaan satu jam lalu tidak berguna lagi.
    expect(forwarder.queue).toHaveLength(3);
    expect(forwarder.queue.map((r: { value: number }) => r.value)).toEqual([3, 4, 5]);
    // Dan pembuangannya dilaporkan, tidak didiamkan.
    expect(messages.join(' ')).toContain('antrean penuh');
  });
});
