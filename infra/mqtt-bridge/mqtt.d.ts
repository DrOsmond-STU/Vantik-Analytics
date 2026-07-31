/**
 * Deklarasi tipe untuk klien MQTT.
 *
 * Berkasnya sendiri sengaja JavaScript polos: jembatan dijalankan apa adanya dengan
 * `node bridge.js` di mesin di lokasi, tanpa langkah build. Deklarasi ini ada supaya
 * pengujian di `services/` tetap dapat memeriksanya dengan tipe.
 */
import { EventEmitter } from 'node:events';

export interface MqttOptions {
  host: string;
  port: number;
  tls?: boolean;
  rejectUnauthorized?: boolean;
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSeconds?: number;
}

export interface MqttMessage {
  topic: string;
  payload: Buffer;
}

export declare class MqttClient extends EventEmitter {
  constructor(options: MqttOptions);
  connect(): void;
  subscribe(filters: string[], qos?: number): void;
  onData(chunk: Buffer): void;
  write(buffer: Buffer): void;
  end(): void;
  destroy(): void;

  on(event: 'message', listener: (message: MqttMessage) => void): this;
  on(event: 'connect' | 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export declare function topicMatches(filter: string, topic: string): boolean;
export declare function encodeLength(value: number): Buffer;
export declare function decodeLength(buffer: Buffer, offset: number): { value: number; bytes: number } | null;
export declare function encodeString(value: string): Buffer;
export declare function packet(type: number, flags: number, payload: Buffer): Buffer;
