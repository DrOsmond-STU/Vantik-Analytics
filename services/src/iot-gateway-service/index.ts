/**
 * iot-gateway-service — Digital Twin Dashboard (PRD 6.17).
 *
 * Prinsip yang ditegakkan di seluruh modul:
 *  - Definisi aset, jenis sensor, satuan, ambang batas, dan tata letak zona
 *    DIKONFIGURASI PENGGUNA, bukan ditanam di kode — inilah yang membuat modul ini
 *    dapat dipakai lintas sektor (fasilitas, armada, energi, lab, kesehatan, industri).
 *  - Prediksi selalu berupa RENTANG WAKTU + TINGKAT KEYAKINAN, bukan angka tunggal
 *    yang menyesatkan; keyakinan rendah ditandai jelas.
 *  - Prediksi TIDAK PERNAH memicu tindakan otomatis berdampak fisik — sistem
 *    menyarankan, keputusan tetap pada manusia.
 */
import { newId, nowIso } from '../platform/db.ts';
import { NotFoundError, ValidationError } from '../platform/errors.ts';
import type { RequestContext } from '../platform/context.ts';
import type { AlertService } from '../alerting-service/index.ts';

export type AssetStatus = 'normal' | 'attention' | 'critical' | 'offline';

export interface SensorDefinition {
  id: string;
  asset_id: string;
  code: string;
  label: string;
  unit: string;
  warn_min: number | null;
  warn_max: number | null;
  crit_min: number | null;
  crit_max: number | null;
  weight: number;
}

export interface AssetRecord {
  id: string;
  zone_id: string | null;
  code: string;
  name: string;
  category: string;
  status: AssetStatus;
  health_score: number;
  pos_x: number | null;
  pos_y: number | null;
  commissioned_at: string | null;
  operating_hours: number;
  created_at: string;
}

export interface SensorReadingView {
  sensorCode: string;
  label: string;
  unit: string;
  value: number;
  observedAt: string;
  status: 'normal' | 'warning' | 'critical';
}

export interface FailurePrediction {
  assetId: string;
  windowStart: string;
  windowEnd: string;
  confidence: number;
  /** Keyakinan di bawah ambang ini WAJIB ditandai jelas di UI (PRD 6.17). */
  lowConfidence: boolean;
  basis: Array<{ sensorCode: string; trend: string; contribution: number }>;
  impactScore: number;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** Status satu pembacaan terhadap ambang yang dikonfigurasi pengguna. */
export function classifyReading(value: number, sensor: SensorDefinition): 'normal' | 'warning' | 'critical' {
  const { crit_min, crit_max, warn_min, warn_max } = sensor;
  if ((crit_min !== null && value < crit_min) || (crit_max !== null && value > crit_max)) return 'critical';
  if ((warn_min !== null && value < warn_min) || (warn_max !== null && value > warn_max)) return 'warning';
  return 'normal';
}

/**
 * Skor kesehatan aset 0–100, dihitung dari kombinasi pembacaan sensor DAN riwayat
 * operasinya (PRD 6.17).
 */
export function computeHealthScore(
  readings: Array<{ sensor: SensorDefinition; value: number }>,
  operatingHours: number,
): number {
  if (readings.length === 0) return 100;

  let weightedPenalty = 0;
  let totalWeight = 0;

  for (const { sensor, value } of readings) {
    const weight = sensor.weight || 1;
    totalWeight += weight;
    const status = classifyReading(value, sensor);
    if (status === 'critical') weightedPenalty += weight * 1;
    else if (status === 'warning') weightedPenalty += weight * 0.45;
    else {
      // Penalti bertahap saat nilai mendekati ambang, bukan lompatan mendadak —
      // memberi peringatan dini alih-alih menunggu ambang terlampaui.
      const span = sensor.warn_max !== null && sensor.warn_min !== null ? sensor.warn_max - sensor.warn_min : null;
      if (span && span > 0) {
        const centre = (sensor.warn_max! + sensor.warn_min!) / 2;
        const drift = Math.min(1, Math.abs(value - centre) / (span / 2));
        weightedPenalty += weight * drift * 0.15;
      }
    }
  }

  const sensorScore = totalWeight === 0 ? 100 : 100 * (1 - weightedPenalty / totalWeight);
  // Keausan: aset yang beroperasi sangat lama menurun perlahan (maks. 10 poin).
  const wearPenalty = Math.min(10, (operatingHours / 50_000) * 10);
  return Number(Math.max(0, Math.min(100, sensorScore - wearPenalty)).toFixed(2));
}

export function statusFromHealth(score: number, hasRecentReading: boolean): AssetStatus {
  if (!hasRecentReading) return 'offline';
  if (score < 50) return 'critical';
  if (score < 75) return 'attention';
  return 'normal';
}

export class DigitalTwinService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly alerts?: AlertService,
  ) {}

  /* ---------------- Konfigurasi aset & sensor ---------------- */

  createZone(input: { name: string; parentId?: string }): { id: string } {
    this.ctx.require('twin:read', { module: 'Digital Twin' });
    this.ctx.requireModule('digital_twin');
    this.ctx.requireWritable();

    const id = newId('zon');
    this.ctx.db.insert('asset_zones', {
      id,
      name: input.name,
      parent_id: input.parentId ?? null,
      layout_json: null,
    });
    this.ctx.log({
      action: 'twin.zone_create',
      module: 'Digital Twin',
      objectType: 'zone',
      objectId: id,
      objectLabel: input.name,
    });
    return { id };
  }

  createAsset(input: {
    code: string;
    name: string;
    category: string;
    zoneId?: string;
    posX?: number;
    posY?: number;
    commissionedAt?: string;
    sensors: Array<{
      code: string;
      label: string;
      unit: string;
      warnMin?: number;
      warnMax?: number;
      critMin?: number;
      critMax?: number;
      weight?: number;
    }>;
  }): { id: string } {
    this.ctx.require('twin:read', { module: 'Digital Twin' });
    this.ctx.requireModule('digital_twin');
    this.ctx.requireWritable();

    if (input.sensors.length === 0) throw new ValidationError('error.asset_requires_sensor');

    const id = newId('ast');
    const at = nowIso();

    this.ctx.db.transaction(() => {
      this.ctx.db.insert('assets', {
        id,
        zone_id: input.zoneId ?? null,
        code: input.code,
        name: input.name,
        category: input.category,
        status: 'offline',
        health_score: 100,
        pos_x: input.posX ?? null,
        pos_y: input.posY ?? null,
        commissioned_at: input.commissionedAt ?? null,
        operating_hours: 0,
        created_at: at,
      });
      for (const sensor of input.sensors) {
        this.ctx.db.insert('sensor_definitions', {
          id: newId('sen'),
          asset_id: id,
          code: sensor.code,
          label: sensor.label,
          unit: sensor.unit,
          warn_min: sensor.warnMin ?? null,
          warn_max: sensor.warnMax ?? null,
          crit_min: sensor.critMin ?? null,
          crit_max: sensor.critMax ?? null,
          weight: sensor.weight ?? 1,
        });
      }
    });

    this.ctx.log({
      action: 'twin.asset_create',
      module: 'Digital Twin',
      objectType: 'asset',
      objectId: id,
      objectLabel: input.name,
      detail: { category: input.category, sensors: input.sensors.length },
    });
    return { id };
  }

  /**
   * Menerima pembacaan sensor (dari jembatan MQTT atau Koneksi Eksternal 6.12).
   * Penyimpangan melewati ambang memicu notifikasi melalui Alert Center (6.16) —
   * bukan jalur notifikasi terpisah.
   *
   * `twin:ingest` dipisahkan dari `twin:read` dengan sengaja. Pembacaan sensor menggerakkan
   * skor kesehatan aset dan memicu notifikasi ambang batas; membiarkan setiap orang yang
   * boleh MELIHAT lantai pabrik juga MENULIS ke sana berarti siapa pun yang punya sesi
   * dapat membuat alarm palsu — atau, lebih buruk, menenggelamkan alarm yang benar di
   * antara pembacaan karangan.
   */
  async ingestReading(input: {
    assetCode: string;
    sensorCode: string;
    value: number;
    observedAt?: string;
  }): Promise<{ status: string; healthScore: number }> {
    this.ctx.require('twin:ingest', { module: 'Digital Twin' });
    this.ctx.requireWritable();

    const asset = this.ctx.db.get<AssetRecord>('assets', { code: input.assetCode });
    if (!asset) throw new NotFoundError();

    const sensor = this.ctx.db.get<SensorDefinition>('sensor_definitions', {
      asset_id: asset.id,
      code: input.sensorCode,
    });
    if (!sensor) throw new NotFoundError('error.sensor_unknown');

    const observedAt = input.observedAt ?? nowIso();
    this.ctx.db.insert('sensor_readings', {
      id: null as unknown as number,
      asset_id: asset.id,
      sensor_code: input.sensorCode,
      observed_at: observedAt,
      value: input.value,
    });

    const latest = this.latestReadings(asset.id);
    const healthScore = computeHealthScore(latest, asset.operating_hours);
    const status = statusFromHealth(healthScore, true);

    this.ctx.db.update('assets', { id: asset.id }, { health_score: healthScore, status });

    const readingStatus = classifyReading(input.value, sensor);
    if (readingStatus !== 'normal' && this.alerts) {
      await this.alerts.evaluate({
        assetId: asset.id,
        sensorCode: input.sensorCode,
        value: input.value,
        label: `${asset.name} · ${sensor.label}`,
        context: { unit: sensor.unit, healthScore, readingStatus },
      });
    }

    return { status, healthScore };
  }

  private latestReadings(assetId: string): Array<{ sensor: SensorDefinition; value: number; observedAt: string }> {
    const sensors = this.ctx.db.all<SensorDefinition>('sensor_definitions', { asset_id: assetId });
    const out: Array<{ sensor: SensorDefinition; value: number; observedAt: string }> = [];
    for (const sensor of sensors) {
      const reading = this.ctx.db.all<{ value: number; observed_at: string }>(
        'sensor_readings',
        { asset_id: assetId, sensor_code: sensor.code },
        { orderBy: 'observed_at DESC', limit: 1 },
      )[0];
      if (reading) out.push({ sensor, value: reading.value, observedAt: reading.observed_at });
    }
    return out;
  }

  /** Denah/peta aset dengan indikator status berwarna, dikelompokkan per zona (PRD 6.17). */
  floorPlan(): Array<{ zone: { id: string; name: string } | null; assets: AssetRecord[] }> {
    this.ctx.require('twin:read', { module: 'Digital Twin' });
    this.ctx.requireModule('digital_twin');

    const zones = this.ctx.db.all<{ id: string; name: string }>('asset_zones', undefined, { orderBy: 'name' });
    const assets = this.ctx.db.all<AssetRecord>('assets', undefined, { orderBy: 'code' });

    const grouped = zones.map((zone) => ({
      zone,
      assets: assets.filter((a) => a.zone_id === zone.id),
    }));
    const unzoned = assets.filter((a) => a.zone_id === null);
    if (unzoned.length > 0) grouped.push({ zone: null as never, assets: unzoned });
    return grouped;
  }

  /** Panel detail aset: pembacaan terkini + status + tren historis (PRD 6.17). */
  assetDetail(assetId: string, historyPoints = 48): {
    asset: AssetRecord;
    readings: SensorReadingView[];
    trends: Array<{ sensorCode: string; points: Array<{ at: string; value: number }> }>;
    prediction: FailurePrediction | null;
  } {
    this.ctx.require('twin:read', { module: 'Digital Twin', objectId: assetId });
    const asset = this.ctx.db.get<AssetRecord>('assets', { id: assetId });
    if (!asset) throw new NotFoundError();

    const latest = this.latestReadings(assetId);
    const readings: SensorReadingView[] = latest.map((r) => ({
      sensorCode: r.sensor.code,
      label: r.sensor.label,
      unit: r.sensor.unit,
      value: r.value,
      observedAt: r.observedAt,
      status: classifyReading(r.value, r.sensor),
    }));

    const trends = latest.map((r) => ({
      sensorCode: r.sensor.code,
      points: this.ctx.db
        .all<{ observed_at: string; value: number }>(
          'sensor_readings',
          { asset_id: assetId, sensor_code: r.sensor.code },
          { orderBy: 'observed_at DESC', limit: historyPoints },
        )
        .reverse()
        .map((p) => ({ at: p.observed_at, value: p.value })),
    }));

    return { asset, readings, trends, prediction: this.predictFailure(assetId) };
  }

  /**
   * Predictive maintenance (PRD 6.17).
   *
   * Menghasilkan RENTANG estimasi waktu + tingkat keyakinan — bukan satu angka.
   * Metode: ekstrapolasi tren linier tiap sensor menuju ambang kritis; keyakinan
   * diturunkan dari kekuatan tren dan jumlah data yang tersedia.
   */
  predictFailure(assetId: string): FailurePrediction | null {
    const asset = this.ctx.db.get<AssetRecord>('assets', { id: assetId });
    if (!asset) return null;

    const sensors = this.ctx.db.all<SensorDefinition>('sensor_definitions', { asset_id: assetId });
    const basis: FailurePrediction['basis'] = [];
    let soonestHours = Infinity;
    let latestHours = 0;
    let bestFit = 0;

    for (const sensor of sensors) {
      const points = this.ctx.db
        .all<{ observed_at: string; value: number }>(
          'sensor_readings',
          { asset_id: assetId, sensor_code: sensor.code },
          { orderBy: 'observed_at DESC', limit: 100 },
        )
        .reverse();
      if (points.length < 5) continue;

      const t0 = Date.parse(points[0]!.observed_at);
      const x = points.map((p) => (Date.parse(p.observed_at) - t0) / 3_600_000); // jam
      const y = points.map((p) => p.value);

      const n = x.length;
      const meanX = x.reduce((a, b) => a + b, 0) / n;
      const meanY = y.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        sxy += (x[i]! - meanX) * (y[i]! - meanY);
        sxx += (x[i]! - meanX) ** 2;
        syy += (y[i]! - meanY) ** 2;
      }
      if (sxx === 0) continue;
      const slope = sxy / sxx;
      const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

      const current = y[n - 1]!;
      let target: number | null = null;
      if (slope > 0 && sensor.crit_max !== null && current < sensor.crit_max) target = sensor.crit_max;
      else if (slope < 0 && sensor.crit_min !== null && current > sensor.crit_min) target = sensor.crit_min;
      if (target === null || slope === 0) continue;

      const hoursToThreshold = (target - current) / slope;
      if (!Number.isFinite(hoursToThreshold) || hoursToThreshold <= 0 || hoursToThreshold > 24 * 365) continue;

      basis.push({
        sensorCode: sensor.code,
        trend: slope > 0 ? 'rising' : 'falling',
        contribution: Number(r2.toFixed(3)),
      });
      soonestHours = Math.min(soonestHours, hoursToThreshold);
      latestHours = Math.max(latestHours, hoursToThreshold);
      bestFit = Math.max(bestFit, r2);
    }

    if (basis.length === 0 || !Number.isFinite(soonestHours)) return null;

    // Lebar rentang mencerminkan ketidakpastian: makin lemah kecocokan tren,
    // makin lebar rentangnya. Menyajikan satu titik waktu akan menyesatkan.
    //
    // PRD 6.17 menuntut prediksi SELALU berupa rentang, bukan angka tunggal. Karena
    // itu ada lebar minimum: bahkan tren yang mulus sempurna (r² = 1) pada data
    // historis tidak menjamin masa depan berperilaku sama, sehingga rentangnya tidak
    // boleh menyusut menjadi satu titik waktu.
    const MIN_RELATIVE_WIDTH = 0.15;
    const uncertainty = 1 - bestFit;
    const windowStartHours = soonestHours * (1 - Math.max(MIN_RELATIVE_WIDTH, 0.4 * uncertainty));
    const windowEndHours =
      Math.max(latestHours, soonestHours) * (1 + Math.max(MIN_RELATIVE_WIDTH, 0.8 * uncertainty));

    const confidence = Number(Math.max(0.05, Math.min(0.95, bestFit * Math.min(1, basis.length / 2))).toFixed(3));
    const impactScore = Number(((100 - asset.health_score) / 100 + (asset.status === 'critical' ? 0.5 : 0)).toFixed(3));

    const prediction: FailurePrediction = {
      assetId,
      windowStart: new Date(Date.now() + windowStartHours * 3_600_000).toISOString(),
      windowEnd: new Date(Date.now() + windowEndHours * 3_600_000).toISOString(),
      confidence,
      lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
      basis,
      impactScore,
    };

    this.ctx.db.insert('failure_predictions', {
      id: newId('fpr'),
      asset_id: assetId,
      predicted_at: nowIso(),
      window_start: prediction.windowStart,
      window_end: prediction.windowEnd,
      confidence,
      basis_json: JSON.stringify(basis),
      impact_score: impactScore,
    });

    return prediction;
  }

  /**
   * Antrean prioritas pemeliharaan, disusun otomatis dari skor kesehatan, estimasi
   * waktu kegagalan, dan dampak operasional aset (PRD 6.17).
   */
  maintenanceQueue(): Array<{
    asset: AssetRecord;
    priority: number;
    prediction: FailurePrediction | null;
    reasonKeys: string[];
  }> {
    this.ctx.require('twin:read', { module: 'Digital Twin' });
    const assets = this.ctx.db.all<AssetRecord>('assets');

    return assets
      .map((asset) => {
        const prediction = this.ctx.db
          .all<{
            window_start: string;
            window_end: string;
            confidence: number;
            basis_json: string;
            impact_score: number;
          }>('failure_predictions', { asset_id: asset.id }, { orderBy: 'predicted_at DESC', limit: 1 })
          .map((p) => ({
            assetId: asset.id,
            windowStart: p.window_start,
            windowEnd: p.window_end,
            confidence: p.confidence,
            lowConfidence: p.confidence < LOW_CONFIDENCE_THRESHOLD,
            basis: JSON.parse(p.basis_json),
            impactScore: p.impact_score,
          }))[0] ?? null;

        const reasonKeys: string[] = [];
        let priority = (100 - asset.health_score) / 100;
        if (asset.status === 'critical') {
          priority += 0.5;
          reasonKeys.push('twin.reason_critical_status');
        }
        if (prediction) {
          const hoursAway = (Date.parse(prediction.windowStart) - Date.now()) / 3_600_000;
          if (hoursAway < 168) {
            priority += 0.4 * prediction.confidence;
            reasonKeys.push('twin.reason_failure_predicted');
          }
          if (prediction.lowConfidence) reasonKeys.push('twin.reason_low_confidence_prediction');
        }
        if (asset.health_score < 75) reasonKeys.push('twin.reason_health_declining');

        return { asset, priority: Number(priority.toFixed(3)), prediction, reasonKeys };
      })
      .filter((entry) => entry.priority > 0.05)
      .sort((a, b) => b.priority - a.priority);
  }

  /** Membuat tiket/perintah kerja langsung dari panel aset (PRD 6.17). */
  createTicket(assetId: string, input: { title: string; priority: 'low' | 'medium' | 'high' | 'urgent'; externalRef?: string }): { id: string } {
    this.ctx.require('twin:ticket', { module: 'Digital Twin', objectId: assetId });
    this.ctx.requireWritable();

    const asset = this.ctx.db.get<AssetRecord>('assets', { id: assetId });
    if (!asset) throw new NotFoundError();

    const id = newId('tkt');
    this.ctx.db.insert('maintenance_tickets', {
      id,
      asset_id: assetId,
      title: input.title,
      priority: input.priority,
      status: 'open',
      created_by: this.ctx.actor.userId,
      created_at: nowIso(),
      external_ref: input.externalRef ?? null,
    });

    this.ctx.log({
      action: 'twin.ticket_created',
      module: 'Digital Twin',
      objectType: 'maintenance_ticket',
      objectId: id,
      objectLabel: input.title,
      detail: { assetId, priority: input.priority },
    });
    return { id };
  }

  /**
   * Simulasi skenario operasional (PRD 6.17): menguji dampak keputusan SEBELUM
   * dijalankan. Hasilnya adalah PROYEKSI — tidak ada perubahan yang benar-benar
   * diterapkan ke aset, dan tidak ada tindakan otomatis berdampak fisik.
   */
  simulate(scenario: {
    name: string;
    actions: Array<{ assetId: string; action: 'shutdown' | 'increase_load' | 'reduce_load'; magnitude?: number }>;
  }): {
    scenario: string;
    projected: {
      capacityChangePercent: number;
      energyChangePercent: number;
      riskChange: number;
      estimatedCostImpact: number;
    };
    perAsset: Array<{ assetId: string; assetName: string; note: string }>;
    disclaimerKey: string;
  } {
    this.ctx.require('twin:read', { module: 'Digital Twin' });
    this.ctx.requireModule('digital_twin');

    const assets = this.ctx.db.all<AssetRecord>('assets');
    const total = Math.max(1, assets.length);

    let capacityChange = 0;
    let energyChange = 0;
    let riskChange = 0;
    const perAsset: Array<{ assetId: string; assetName: string; note: string }> = [];

    for (const action of scenario.actions) {
      const asset = assets.find((a) => a.id === action.assetId);
      if (!asset) continue;
      const share = 100 / total;
      const magnitude = action.magnitude ?? 1;

      if (action.action === 'shutdown') {
        capacityChange -= share;
        energyChange -= share;
        // Menghentikan aset untuk pemeliharaan menurunkan risiko kegagalan tak terencana.
        riskChange -= (100 - asset.health_score) / 100;
        perAsset.push({ assetId: asset.id, assetName: asset.name, note: 'twin.sim_shutdown' });
      } else if (action.action === 'increase_load') {
        capacityChange += share * magnitude * 0.6;
        energyChange += share * magnitude;
        riskChange += ((100 - asset.health_score) / 100) * magnitude * 0.5;
        perAsset.push({ assetId: asset.id, assetName: asset.name, note: 'twin.sim_increase_load' });
      } else {
        capacityChange -= share * magnitude * 0.6;
        energyChange -= share * magnitude;
        riskChange -= ((100 - asset.health_score) / 100) * magnitude * 0.3;
        perAsset.push({ assetId: asset.id, assetName: asset.name, note: 'twin.sim_reduce_load' });
      }
    }

    return {
      scenario: scenario.name,
      projected: {
        capacityChangePercent: Number(capacityChange.toFixed(2)),
        energyChangePercent: Number(energyChange.toFixed(2)),
        riskChange: Number(riskChange.toFixed(3)),
        estimatedCostImpact: Number((energyChange * 150_000).toFixed(0)),
      },
      perAsset,
      // Sistem menyarankan; keputusan tetap pada manusia (PRD 6.17).
      disclaimerKey: 'twin.simulation_is_projection_only',
    };
  }

  /** Pemantauan konsumsi energi per aset/zona dengan pembandingan antar-periode (PRD 6.17). */
  energyComparison(sensorCode = 'power'): Array<{
    assetId: string;
    assetName: string;
    zoneName: string | null;
    currentPeriod: number;
    previousPeriod: number;
    changePercent: number;
  }> {
    this.ctx.require('twin:read', { module: 'Digital Twin' });

    const now = Date.now();
    const currentStart = new Date(now - 30 * 86_400_000).toISOString();
    const previousStart = new Date(now - 60 * 86_400_000).toISOString();

    const assets = this.ctx.db.all<AssetRecord>('assets');
    const zones = new Map(
      this.ctx.db.all<{ id: string; name: string }>('asset_zones').map((z) => [z.id, z.name]),
    );

    return assets
      .map((asset) => {
        const sum = (from: string, to: string): number => {
          const row = this.ctx.db.rawOne<{ total: number | null }>(
            `SELECT SUM(value) AS total FROM sensor_readings
              WHERE tenant_id = :tenant_id AND asset_id = :asset_id AND sensor_code = :sensor_code
                AND observed_at >= :from AND observed_at < :to`,
            { asset_id: asset.id, sensor_code: sensorCode, from, to },
          );
          return row?.total ?? 0;
        };
        const currentPeriod = sum(currentStart, new Date(now).toISOString());
        const previousPeriod = sum(previousStart, currentStart);
        return {
          assetId: asset.id,
          assetName: asset.name,
          zoneName: asset.zone_id ? (zones.get(asset.zone_id) ?? null) : null,
          currentPeriod: Number(currentPeriod.toFixed(2)),
          previousPeriod: Number(previousPeriod.toFixed(2)),
          changePercent:
            previousPeriod === 0 ? 0 : Number((((currentPeriod - previousPeriod) / previousPeriod) * 100).toFixed(2)),
        };
      })
      .filter((row) => row.currentPeriod > 0 || row.previousPeriod > 0);
  }
}
