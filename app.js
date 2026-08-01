/**
 * Berkas startup aplikasi.
 *
 * Dipakai oleh Phusion Passenger (cPanel/CloudLinux "Setup Node.js App") maupun oleh
 * `node app.js` biasa pada VPS. Passenger menetapkan PORT dan cwd sendiri, jadi
 * keduanya tidak pernah dipatok di kode.
 */
'use strict';

// Memuat variabel dari .env bila ada, tanpa dependensi tambahan.
require('./load-env.js');

const { startServer } = require('./server/server.js');

startServer();
