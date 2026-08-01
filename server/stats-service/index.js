"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * stats-service — Statistik Deskriptif (6.22), Uji Hipotesis (6.23),
 * Regresi & Korelasi (6.24).
 *
 * Dipisah dari `ai-engine-service` secara sengaja (ARCHITECTURE.md Bagian 3):
 * komputasi statistik bersifat DETERMINISTIK dan dapat diaudit (input sama → output
 * sama persis), sedangkan AI engine probabilistik dan bergantung penyedia eksternal.
 * Pemisahan ini memungkinkan hasil statistik di-cache dan diverifikasi independen —
 * penting karena outputnya dipakai untuk laporan resmi dan kajian kebijakan.
 */
__exportStar(require("./distributions.js"), exports);
__exportStar(require("./descriptive.js"), exports);
__exportStar(require("./hypothesis.js"), exports);
__exportStar(require("./regression.js"), exports);
__exportStar(require("./service.js"), exports);
//# sourceMappingURL=index.js.map