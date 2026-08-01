"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WHATSAPP_CLOUD_BODY_TEMPLATE = exports.ChannelRoutingTransport = exports.WebhookTransport = exports.TelegramTransport = exports.SmtpTransport = exports.SMTP_TIMEOUT_MS = void 0;
exports.sanitiseHeaderValue = sanitiseHeaderValue;
exports.encodeSubject = encodeSubject;
exports.stuffDots = stuffDots;
exports.transportFromEnv = transportFromEnv;
/**
 * Transport notifikasi nyata: email (SMTP), WhatsApp, dan Telegram.
 *
 * Seluruhnya DIKONFIGURASI LEWAT VARIABEL LINGKUNGAN dan dibiarkan kosong secara bawaan.
 * Kanal yang tidak dikonfigurasi berperilaku persis seperti sebelumnya — mengantre tanpa
 * mengirim, dan MENGATAKANNYA (`delivered: false`). Itu keputusan sadar: "tercatat
 * terkirim" yang salah lebih berbahaya daripada kegagalan yang terlihat, terutama untuk
 * OTP dan kode pemulihan kata sandi.
 *
 * TANPA DEPENDENSI BARU. SMTP ditulis di atas `node:tls`/`node:net` alih-alih memakai
 * pustaka, karena satu paket yang gagal terpasang adalah masalah pemasangan nomor satu di
 * shared hosting — dan seluruh bentuk proyek ini memang menghindarinya. Risiko "menulis
 * klien protokol sendiri" dibayar dengan uji yang berbicara di tingkat socket terhadap
 * server SMTP tiruan, bukan dengan harapan.
 */
const node_tls_1 = require("node:tls");
const node_net_1 = require("node:net");
/** Batas waktu satu percakapan SMTP. Koneksi yang menggantung tidak boleh menahan permintaan. */
exports.SMTP_TIMEOUT_MS = 15_000;
/* ================= Sanitasi ================= */
/**
 * Membuang CR/LF dari nilai yang akan masuk header SMTP.
 *
 * Tanpa ini, subjek atau alamat yang memuat baris baru dapat MENYISIPKAN header tambahan —
 * termasuk `Bcc:` — sehingga satu pesan dapat dialihkan ke penerima lain. Kanal ini
 * membawa OTP dan kode pemulihan kata sandi, jadi penyisipan header di sini setara dengan
 * penyerahan kunci akun.
 */
function sanitiseHeaderValue(value) {
    return value.replace(/[\r\n]+/g, ' ').trim();
}
/**
 * Menyandikan subjek sebagai encoded-word RFC 2047 bila memuat karakter non-ASCII.
 *
 * Diperlukan karena subjek di sistem ini berbahasa Indonesia dan memuat karakter seperti
 * "—" atau "×". Tanpa penyandian, sebagian server memotong atau mengacaukannya, dan yang
 * diterima pengguna adalah subjek rusak — bukan kegagalan yang terlihat.
 */
function encodeSubject(subject) {
    const clean = sanitiseHeaderValue(subject);
    // eslint-disable-next-line no-control-regex
    if (!/[^\x20-\x7E]/.test(clean))
        return clean;
    return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}
/**
 * Dot-stuffing RFC 5321: baris yang dimulai dengan titik diberi titik tambahan.
 *
 * Tanpa ini, badan pesan yang kebetulan punya baris berawalan "." akan mengakhiri data
 * lebih awal — pesan terpotong, dan server tetap menjawab OK.
 */
function stuffDots(body) {
    return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}
/**
 * Percakapan SMTP satu pesan.
 *
 * Sengaja minimal: satu penerima, badan teks polos, satu pesan per koneksi. Tidak ada
 * pooling, tidak ada lampiran. Menambah keduanya berarti menambah keadaan yang harus
 * benar di lingkungan yang me-recycle proses — dan yang dibutuhkan sistem ini adalah
 * mengirim beberapa pesan pendek per hari secara andal.
 */
class SmtpTransport {
    config;
    delivers = true;
    constructor(config) {
        this.config = config;
    }
    async send(input) {
        const recipient = sanitiseHeaderValue(input.recipient);
        if (!recipient.includes('@'))
            return { delivered: false, failureReason: 'invalid_recipient' };
        let socket = null;
        try {
            socket = await this.openSocket();
            const say = this.conversation(socket);
            await say(null, [220]);
            let greeting = await say(`EHLO ${this.hostnameForEhlo()}`, [250]);
            if (!this.config.implicitTls) {
                if (!/STARTTLS/i.test(greeting.text)) {
                    // Menolak melanjutkan tanpa enkripsi. Mengirim kredensial dan kode pemulihan
                    // dalam bentuk polos lebih buruk daripada tidak mengirim sama sekali.
                    return { delivered: false, failureReason: 'server_without_starttls' };
                }
                await say('STARTTLS', [220]);
                socket = await this.upgradeToTls(socket);
                const secureSay = this.conversation(socket);
                greeting = await secureSay(`EHLO ${this.hostnameForEhlo()}`, [250]);
                return await this.deliver(secureSay, greeting, recipient, input);
            }
            return await this.deliver(say, greeting, recipient, input);
        }
        catch (error) {
            // Pesan kesalahan dari socket TIDAK memuat kredensial maupun badan pesan; hanya
            // ringkasannya yang dikembalikan supaya alasan kegagalan dapat dibaca operator
            // tanpa membocorkan isi OTP ke tabel outbox.
            return { delivered: false, failureReason: summariseError(error) };
        }
        finally {
            socket?.destroy();
        }
    }
    async deliver(say, greeting, recipient, input) {
        if (this.config.user && this.config.pass) {
            if (/AUTH[ -=][^\r\n]*PLAIN/i.test(greeting.text)) {
                const token = Buffer.from(`\0${this.config.user}\0${this.config.pass}`, 'utf8').toString('base64');
                await say(`AUTH PLAIN ${token}`, [235]);
            }
            else if (/AUTH[ -=][^\r\n]*LOGIN/i.test(greeting.text)) {
                await say('AUTH LOGIN', [334]);
                await say(Buffer.from(this.config.user, 'utf8').toString('base64'), [334]);
                await say(Buffer.from(this.config.pass, 'utf8').toString('base64'), [235]);
            }
            else {
                return { delivered: false, failureReason: 'server_without_supported_auth' };
            }
        }
        await say(`MAIL FROM:<${sanitiseHeaderValue(this.config.from)}>`, [250]);
        await say(`RCPT TO:<${recipient}>`, [250, 251]);
        await say('DATA', [354]);
        const headers = [
            `From: ${sanitiseHeaderValue(this.config.from)}`,
            `To: ${recipient}`,
            `Subject: ${encodeSubject(input.subject)}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            `Date: ${new Date().toUTCString()}`,
        ].join('\r\n');
        await say(`${headers}\r\n\r\n${stuffDots(input.body)}\r\n.`, [250]);
        await say('QUIT', [221]).catch(() => undefined); // penutupan kasar bukan kegagalan kirim
        return { delivered: true };
    }
    /** Nama host untuk EHLO. Tidak perlu dapat diselesaikan DNS; harus ada dan tanpa spasi. */
    hostnameForEhlo() {
        const domain = this.config.from.split('@')[1];
        return domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'localhost';
    }
    openSocket() {
        return new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            const socket = this.config.implicitTls
                ? (0, node_tls_1.connect)({
                    host: this.config.host,
                    port: this.config.port,
                    rejectUnauthorized: !this.config.allowInsecureTls,
                })
                : (0, node_net_1.connect)({ host: this.config.host, port: this.config.port });
            socket.setTimeout(exports.SMTP_TIMEOUT_MS, () => socket.destroy(new Error('smtp_timeout')));
            socket.once('error', onError);
            socket.once(this.config.implicitTls ? 'secureConnect' : 'connect', () => {
                socket.removeListener('error', onError);
                resolve(socket);
            });
        });
    }
    upgradeToTls(plain) {
        return new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            const secure = (0, node_tls_1.connect)({
                socket: plain,
                servername: this.config.host,
                rejectUnauthorized: !this.config.allowInsecureTls,
            }, () => {
                secure.removeListener('error', onError);
                resolve(secure);
            });
            secure.setTimeout(exports.SMTP_TIMEOUT_MS, () => secure.destroy(new Error('smtp_timeout')));
            secure.once('error', onError);
        });
    }
    /**
     * Membuat fungsi percakapan atas sebuah socket.
     *
     * Balasan SMTP dapat berupa beberapa baris (`250-...` lalu `250 ...`); pembacaan
     * dianggap selesai hanya ketika baris terakhir memakai spasi, bukan tanda hubung.
     */
    conversation(socket) {
        let buffer = '';
        const pending = [];
        const flush = () => {
            while (pending.length > 0) {
                const match = /^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/.exec(buffer);
                if (!match)
                    return;
                const chunk = buffer.slice(0, match[0].length);
                buffer = buffer.slice(match[0].length);
                const waiter = pending.shift();
                const code = Number(match[1]);
                if (waiter.expect.includes(code))
                    waiter.resolve({ code, text: chunk });
                else
                    waiter.reject(new Error(`smtp_${code}`));
            }
        };
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
            flush();
        });
        socket.on('error', (error) => {
            while (pending.length > 0)
                pending.shift().reject(error);
        });
        socket.on('close', () => {
            while (pending.length > 0)
                pending.shift().reject(new Error('smtp_connection_closed'));
        });
        return (line, expect) => new Promise((resolve, reject) => {
            pending.push({ expect, resolve, reject });
            flush();
            if (line !== null)
                socket.write(`${line}\r\n`);
        });
    }
}
exports.SmtpTransport = SmtpTransport;
/* ================= HTTP: Telegram & WhatsApp ================= */
/** Telegram Bot API. `recipient` adalah chat id, bukan nomor telepon. */
class TelegramTransport {
    config;
    delivers = true;
    constructor(config) {
        this.config = config;
    }
    async send(input) {
        try {
            const response = await fetch(`${this.config.apiBase}/bot${this.config.botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: input.recipient,
                    text: input.subject ? `${input.subject}\n\n${input.body}` : input.body,
                    disable_web_page_preview: true,
                }),
                signal: AbortSignal.timeout(exports.SMTP_TIMEOUT_MS),
            });
            if (!response.ok)
                return { delivered: false, failureReason: `telegram_http_${response.status}` };
            return { delivered: true };
        }
        catch (error) {
            return { delivered: false, failureReason: summariseError(error) };
        }
    }
}
exports.TelegramTransport = TelegramTransport;
/**
 * Transport HTTP berbentuk template — dipakai untuk WhatsApp dan kanal lain.
 *
 * Bentuk badannya ditentukan operator, bukan ditanam di kode, karena "API WhatsApp" bukan
 * satu hal. Placeholder yang tersedia: `{{recipient}}`, `{{subject}}`, `{{body}}`, dan
 * masing-masing disisipkan sebagai string JSON yang sudah di-escape sehingga tanda kutip
 * atau baris baru di dalam pesan tidak merusak badan permintaan.
 */
class WebhookTransport {
    config;
    label;
    delivers = true;
    constructor(config, label) {
        this.config = config;
        this.label = label;
    }
    async send(input) {
        const jsonEscape = (value) => JSON.stringify(value).slice(1, -1);
        const body = this.config.bodyTemplate
            .replace(/\{\{recipient\}\}/g, jsonEscape(input.recipient))
            .replace(/\{\{subject\}\}/g, jsonEscape(input.subject))
            .replace(/\{\{body\}\}/g, jsonEscape(input.body));
        try {
            const response = await fetch(this.config.url, {
                method: this.config.method,
                headers: { 'Content-Type': 'application/json', ...this.config.headers },
                body,
                signal: AbortSignal.timeout(exports.SMTP_TIMEOUT_MS),
            });
            if (!response.ok)
                return { delivered: false, failureReason: `${this.label}_http_${response.status}` };
            return { delivered: true };
        }
        catch (error) {
            return { delivered: false, failureReason: summariseError(error) };
        }
    }
}
exports.WebhookTransport = WebhookTransport;
/* ================= Perutean per kanal ================= */
/**
 * Meneruskan pesan ke transport sesuai kanalnya.
 *
 * Kanal yang tidak punya transport TIDAK dianggap terkirim — ia dijawab
 * `channel_not_configured`, sama jujurnya dengan sebelum ada transport sama sekali.
 * `delivers` bernilai true bila ADA setidaknya satu kanal terkonfigurasi, karena itulah
 * yang menentukan apakah pemanggil layak mencoba ulang.
 */
class ChannelRoutingTransport {
    routes;
    delivers;
    constructor(routes) {
        this.routes = routes;
        this.delivers = Object.keys(routes).length > 0;
    }
    configuredChannels() {
        return Object.keys(this.routes);
    }
    canDeliver(channel) {
        return this.routes[channel] !== undefined;
    }
    async send(input) {
        const transport = this.routes[input.channel];
        if (!transport)
            return { delivered: false, failureReason: 'channel_not_configured' };
        return transport.send(input);
    }
}
exports.ChannelRoutingTransport = ChannelRoutingTransport;
/* ================= Perakitan dari variabel lingkungan ================= */
function trimmed(value) {
    return (value ?? '').trim();
}
/** Bentuk badan bawaan untuk WhatsApp Cloud API milik Meta. */
exports.WHATSAPP_CLOUD_BODY_TEMPLATE = '{"messaging_product":"whatsapp","to":"{{recipient}}","type":"text",' +
    '"text":{"preview_url":false,"body":"{{subject}}\\n\\n{{body}}"}}';
/**
 * Merakit transport dari variabel lingkungan.
 *
 * Sebuah kanal aktif HANYA bila seluruh nilai wajibnya terisi. Konfigurasi setengah jadi
 * — host ada tetapi pengirim kosong — TIDAK diaktifkan, karena kanal yang aktif tetapi
 * pasti gagal hanya menghasilkan pesan berstatus `failed` yang membingungkan, sementara
 * `queued` menyatakan keadaan yang sebenarnya: belum dikonfigurasi.
 *
 * Mengembalikan `null` bila tidak ada satu pun kanal terkonfigurasi, sehingga pemanggil
 * dapat mempertahankan perilaku antre-tanpa-mengirim tanpa cabang khusus.
 */
function transportFromEnv(env = process.env) {
    const routes = {};
    const smtpHost = trimmed(env.VANTIK_SMTP_HOST);
    const smtpFrom = trimmed(env.VANTIK_SMTP_FROM);
    if (smtpHost && smtpFrom) {
        const port = Number(trimmed(env.VANTIK_SMTP_PORT)) || 587;
        routes.email = new SmtpTransport({
            host: smtpHost,
            port,
            user: trimmed(env.VANTIK_SMTP_USER) || undefined,
            pass: trimmed(env.VANTIK_SMTP_PASSWORD) || undefined,
            from: smtpFrom,
            // Port 465 memakai TLS sejak koneksi; 587 memulai polos lalu STARTTLS. Dapat
            // dipaksa lewat VANTIK_SMTP_IMPLICIT_TLS untuk host yang tidak lazim.
            implicitTls: trimmed(env.VANTIK_SMTP_IMPLICIT_TLS)
                ? trimmed(env.VANTIK_SMTP_IMPLICIT_TLS).toLowerCase() === 'true'
                : port === 465,
            allowInsecureTls: trimmed(env.VANTIK_SMTP_ALLOW_INSECURE_TLS).toLowerCase() === 'true',
        });
    }
    const telegramToken = trimmed(env.VANTIK_TELEGRAM_BOT_TOKEN);
    if (telegramToken) {
        routes.telegram = new TelegramTransport({
            botToken: telegramToken,
            apiBase: trimmed(env.VANTIK_TELEGRAM_API_BASE) || 'https://api.telegram.org',
        });
    }
    const waUrl = trimmed(env.VANTIK_WHATSAPP_URL);
    if (waUrl) {
        let headers = {};
        const rawHeaders = trimmed(env.VANTIK_WHATSAPP_HEADERS);
        if (rawHeaders) {
            try {
                const parsed = JSON.parse(rawHeaders);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
                }
            }
            catch {
                // Header yang tidak dapat diurai DIABAIKAN, bukan menggagalkan boot: satu tanda
                // kutip yang salah di `.env` tidak boleh membuat seluruh aplikasi tidak menyala.
                headers = {};
            }
        }
        const token = trimmed(env.VANTIK_WHATSAPP_TOKEN);
        if (token && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
            headers.Authorization = `Bearer ${token}`;
        }
        routes.whatsapp = new WebhookTransport({
            url: waUrl,
            method: trimmed(env.VANTIK_WHATSAPP_METHOD) || 'POST',
            headers,
            bodyTemplate: trimmed(env.VANTIK_WHATSAPP_BODY_TEMPLATE) || exports.WHATSAPP_CLOUD_BODY_TEMPLATE,
        }, 'whatsapp');
    }
    return Object.keys(routes).length > 0 ? new ChannelRoutingTransport(routes) : null;
}
/**
 * Ringkasan kesalahan yang aman dicatat.
 *
 * Sengaja hanya kode/nama, bukan pesan penuh: pesan kesalahan socket dan HTTP dapat
 * memuat URL berikut token di dalamnya, dan alasan kegagalan disimpan di tabel outbox
 * yang dapat dibaca operator.
 */
function summariseError(error) {
    if (error instanceof Error) {
        const code = error.code;
        if (code)
            return String(code).toLowerCase();
        if (/^smtp_/.test(error.message))
            return error.message;
        return error.name === 'Error' ? 'send_failed' : error.name.toLowerCase();
    }
    return 'send_failed';
}
//# sourceMappingURL=transports.js.map