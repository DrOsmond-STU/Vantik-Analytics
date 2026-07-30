/**
 * Kamus istilah terpusat — DESIGN.md Bagian 8.2.
 *
 * Aturan yang ditegakkan berkas ini:
 *  - TIDAK ADA string UI tertanam langsung di komponen; semuanya lewat kunci
 *    `namespace.key` (TASK_INSTRUCTION.md Bagian 5 & 7).
 *  - Nama modul & elemen produk TETAP dalam Bahasa Inggris di kedua bahasa antarmuka
 *    (DESIGN.md 8.1, BRAND.md Bagian 7) — "KPI Center", bukan "Pusat KPI".
 *  - Beberapa istilah manajemen kinerja (On Track / At Risk) sengaja dibiarkan sama
 *    di kedua bahasa; keputusan per istilah didokumentasikan di sini, bukan diputuskan
 *    ad-hoc oleh pengembang saat coding.
 *  - Istilah teknis dijaga konsisten: "Threshold" SELALU "Ambang Batas" (DESIGN.md 12).
 */

export type Locale = 'id' | 'en';

export const dictionary = {
  /* ---------------- Aksi ---------------- */
  'action.publish': ['Publikasikan', 'Publish'],
  'action.export': ['Ekspor', 'Export'],
  'action.add_new': ['+ Tambah Baru', '+ Add New'],
  'action.test_connection': ['Uji Koneksi', 'Test Connection'],
  'action.save_draft': ['Simpan Draf', 'Save Draft'],
  'action.upload': ['Unggah', 'Upload'],
  'action.certify': ['Sertifikasi', 'Certify'],
  'action.reject': ['Tolak', 'Reject'],
  'action.run': ['Jalankan', 'Run'],
  'action.refresh': ['Muat Ulang', 'Refresh'],
  'action.cancel': ['Batal', 'Cancel'],
  'action.close': ['Tutup', 'Close'],
  'action.approve': ['Setujui', 'Approve'],
  'action.revoke': ['Cabut', 'Revoke'],
  'action.acknowledge': ['Tindak Lanjuti', 'Acknowledge'],
  'action.download': ['Unduh', 'Download'],
  'action.search': ['Cari', 'Search'],
  'action.generate': ['Hasilkan', 'Generate'],
  'action.validate': ['Validasi', 'Validate'],
  'action.simulate': ['Simulasikan', 'Simulate'],
  'action.create_ticket': ['Buat Tiket', 'Create Ticket'],
  'action.unbind': ['Lepas Ikatan', 'Unbind'],
  'action.logout': ['Keluar', 'Sign Out'],
  'action.login': ['Masuk', 'Sign In'],
  'action.verify': ['Verifikasi', 'Verify'],
  'action.back': ['Kembali', 'Back'],
  'action.mfa_enroll': ['Aktifkan verifikasi dua langkah', 'Set up two-step verification'],
  'action.mfa_activate': ['Aktifkan', 'Activate'],
  'action.mfa_disable': ['Matikan verifikasi dua langkah', 'Turn off two-step verification'],
  'action.mfa_new_recovery_codes': ['Terbitkan kode pemulihan baru', 'Issue new recovery codes'],
  'action.copy': ['Salin', 'Copy'],
  'action.password_change': ['Ganti Kata Sandi', 'Change Password'],
  'action.start_trial': ['Berlangganan', 'Subscribe'],
  'action.subscribe': ['Berlangganan', 'Subscribe'],
  'action.forgot_password': ['Lupa kata sandi?', 'Forgot your password?'],
  'action.back_to_home': ['Kembali ke halaman depan', 'Back to home'],
  'action.send_reset': ['Kirim Kode Pemulihan', 'Send Recovery Code'],
  'action.have_reset_code': ['Saya sudah punya kodenya', 'I already have the code'],
  'action.reset_password': ['Atur Ulang Kata Sandi', 'Reset Password'],
  'action.view_detail': ['Lihat Detail', 'View Detail'],

  /* ---------------- Status ---------------- */
  // Istilah manajemen kinerja yang lazim dipakai bilingual (DESIGN.md 8.2 catatan).
  'status.on_track': ['On Track', 'On Track'],
  'status.at_risk': ['At Risk', 'At Risk'],
  'status.critical': ['Kritis', 'Critical'],
  'status.active': ['Aktif', 'Active'],
  'status.inactive': ['Nonaktif', 'Inactive'],
  'status.draft': ['Draf', 'Draft'],
  'status.certified': ['Certified', 'Certified'],
  'status.rejected': ['Ditolak', 'Rejected'],
  'status.processing': ['Diproses', 'Processing'],
  'status.ready': ['Siap', 'Ready'],
  'status.failed': ['Gagal', 'Failed'],
  'status.connected': ['Terhubung', 'Connected'],
  'status.auth_failed': ['Gagal Autentikasi', 'Authentication Failed'],
  'status.sync_pending': ['Sinkron Tertunda', 'Sync Pending'],
  'status.never_tested': ['Belum Diuji', 'Never Tested'],
  'status.locked': ['Terkunci', 'Locked'],
  'status.normal': ['Normal', 'Normal'],
  'status.attention': ['Perhatian', 'Attention'],
  'status.offline': ['Nonaktif', 'Offline'],
  'status.pending_approval': ['Menunggu Persetujuan', 'Pending Approval'],
  'status.approved': ['Disetujui', 'Approved'],
  'status.validated': ['Tervalidasi', 'Validated'],
  'status.suspended': ['Disuspensi', 'Suspended'],
  'status.trial': ['Uji Coba', 'Trial'],
  'status.read_only': ['Baca-Saja', 'Read Only'],
  'status.past_due': ['Jatuh Tempo', 'Past Due'],

  /* ---------------- Tabel & label umum ---------------- */
  'table.owner': ['Pemilik', 'Owner'],
  'table.last_login': ['Login Terakhir', 'Last Login'],
  'table.name': ['Nama', 'Name'],
  'table.status': ['Status', 'Status'],
  'table.created_at': ['Dibuat', 'Created'],
  'table.updated_at': ['Diperbarui', 'Updated'],
  'table.actions': ['Aksi', 'Actions'],
  'table.score': ['Skor', 'Score'],
  'table.target': ['Target', 'Target'],
  'table.threshold': ['Ambang Batas', 'Threshold'],
  'table.value': ['Nilai', 'Value'],
  'table.period': ['Periode', 'Period'],
  'table.division': ['Divisi', 'Division'],
  'table.position': ['Jabatan', 'Position'],
  'table.email': ['Email', 'Email'],
  'table.nik': ['NIK', 'Employee ID'],
  'table.role': ['Peran', 'Role'],
  'table.roles': ['Peran', 'Roles'],
  'table.type': ['Jenis', 'Type'],
  'table.rows': ['Baris', 'Rows'],
  'table.size': ['Ukuran', 'Size'],
  'table.quality_score': ['Skor Kualitas', 'Quality Score'],
  'table.classification': ['Klasifikasi', 'Classification'],
  'table.certification': ['Sertifikasi', 'Certification'],
  'table.channel': ['Kanal', 'Channel'],
  'table.recipient': ['Penerima', 'Recipient'],
  'table.severity': ['Kekritisan', 'Severity'],
  'table.module': ['Modul', 'Module'],
  'table.action': ['Aksi', 'Action'],
  'table.actor': ['Pengguna', 'User'],
  'table.timestamp': ['Waktu', 'Timestamp'],
  'table.outcome': ['Hasil', 'Outcome'],
  'table.object': ['Objek', 'Object'],
  'table.device': ['Perangkat', 'Device'],
  'table.last_seen': ['Terakhir Aktif', 'Last Seen'],
  'table.ip': ['Alamat IP', 'IP Address'],
  'table.unit': ['Satuan', 'Unit'],
  'table.trend': ['Tren', 'Trend'],
  'table.total': ['Total', 'Total'],
  'table.usage': ['Penggunaan', 'Usage'],
  'table.quota': ['Kuota', 'Quota'],
  'table.amount': ['Jumlah', 'Amount'],
  'table.due_date': ['Jatuh Tempo', 'Due Date'],
  'table.invoice_number': ['Nomor Faktur', 'Invoice Number'],

  /* ---------------- Kondisi kosong (ajakan bertindak — DESIGN.md 12) ---------------- */
  'empty.no_data': ['Belum ada data untuk periode ini.', 'No data available for this period.'],
  'empty.no_dataset': [
    'Belum ada dataset — unggah CSV atau hubungkan sumber eksternal.',
    'No datasets yet — upload a CSV or connect an external source.',
  ],
  'empty.no_kpi': [
    'Belum ada KPI — tetapkan definisi KPI pertama untuk mulai memantau kinerja.',
    'No KPIs yet — define your first KPI to start tracking performance.',
  ],
  'empty.no_dashboard': [
    'Belum ada dashboard — mulai dari template siap pakai atau kanvas kosong.',
    'No dashboards yet — start from a ready-made template or a blank canvas.',
  ],
  'empty.no_alert': [
    'Belum ada aturan notifikasi — tetapkan ambang batas KPI untuk mulai menerima peringatan.',
    'No alert rules yet — set a KPI threshold to start receiving notifications.',
  ],
  'empty.no_connection': [
    'Belum ada koneksi — hubungkan API atau basis data untuk sinkronisasi otomatis.',
    'No connections yet — connect an API or database for automatic syncing.',
  ],
  'empty.no_asset': [
    'Belum ada aset terdaftar — tambahkan aset dan sensornya untuk mulai memantau.',
    'No assets registered — add an asset and its sensors to start monitoring.',
  ],
  'empty.no_log': ['Belum ada aktivitas tercatat pada rentang ini.', 'No activity recorded in this range.'],
  'empty.module_not_in_plan': [
    'Modul ini tidak termasuk paket langganan Anda saat ini.',
    'This module is not included in your current subscription plan.',
  ],

  /* ---------------- Kesalahan (dijelaskan, bukan minta maaf — DESIGN.md 12) ---------------- */
  'error.upload_failed': [
    'Unggahan gagal — periksa format kolom dan coba lagi.',
    'Upload failed — check your column format and try again.',
  ],
  'error.upload_invalid_name': ['Nama berkas tidak valid.', 'Invalid file name.'],
  'error.upload_no_extension': ['Berkas tidak memiliki ekstensi.', 'File has no extension.'],
  'error.upload_disguised_extension': [
    'Berkas ditolak — ekstensi ganda tidak diizinkan.',
    'File rejected — multiple extensions are not allowed.',
  ],
  'error.upload_extension_not_allowed': [
    'Hanya berkas .csv dan .xlsx yang diterima.',
    'Only .csv and .xlsx files are accepted.',
  ],
  'error.upload_malware_detected': [
    'Berkas ditolak — pemindaian keamanan menemukan konten berbahaya.',
    'File rejected — the security scan found malicious content.',
  ],
  'error.upload_too_many_rows': [
    'Berkas melebihi batas jumlah baris yang dikonfigurasi.',
    'File exceeds the configured row limit.',
  ],
  'error.upload_payload_required': ['Berkas belum dipilih.', 'No file selected.'],
  'error.upload_corrupt_file': ['Berkas rusak atau tidak dapat dibaca.', 'File is corrupt or unreadable.'],
  'error.xlsx_conversion_required': [
    'Berkas XLSX perlu dikonversi ke CSV terlebih dahulu.',
    'XLSX files need to be converted to CSV first.',
  ],
  'error.csv_empty': ['Berkas tidak memuat baris data.', 'The file contains no data rows.'],
  'error.csv_duplicate_headers': ['Nama kolom duplikat pada baris header.', 'Duplicate column names in the header row.'],
  'error.csv_missing_column': ['Kolom wajib tidak ditemukan.', 'A required column is missing.'],
  'error.csv_missing_value': ['Nilai wajib kosong pada baris ini.', 'A required value is empty in this row.'],
  'error.invalid_credentials': ['Email atau kata sandi tidak cocok.', 'Email or password does not match.'],
  'error.account_locked': [
    'Akun terkunci sementara setelah beberapa percobaan gagal.',
    'Account temporarily locked after repeated failed attempts.',
  ],
  'error.account_disabled': ['Akun dinonaktifkan.', 'This account is disabled.'],
  'error.missing_credentials': ['Lengkapi email dan kata sandi.', 'Enter both email and password.'],
  'error.validation_failed': [
    'Permintaan tidak lengkap atau tidak sesuai format.',
    'The request is incomplete or malformed.',
  ],
  'error.formula_too_long': [
    'Formula terlalu panjang untuk diproses.',
    'The formula is too long to process.',
  ],
  'error.mfa_enrolment_required': [
    'Peran Anda mewajibkan verifikasi dua langkah. Aktifkan dulu sebelum melanjutkan.',
    'Your role requires two-step verification. Set it up before continuing.',
  ],
  'error.mfa_required_by_role': [
    'Verifikasi dua langkah tidak dapat dimatikan untuk peran Anda.',
    'Two-step verification cannot be turned off for your role.',
  ],
  'error.mfa_code_invalid': ['Kode verifikasi tidak cocok.', 'The verification code does not match.'],
  'error.mfa_challenge_invalid': [
    'Sesi verifikasi sudah tidak berlaku.',
    'The verification session is no longer valid.',
  ],
  'error.mfa_too_many_attempts': [
    'Terlalu banyak percobaan kode.',
    'Too many code attempts.',
  ],
  'error.mfa_already_active': [
    'Verifikasi dua langkah sudah aktif.',
    'Two-step verification is already active.',
  ],
  'error.mfa_not_active': [
    'Verifikasi dua langkah belum aktif.',
    'Two-step verification is not active yet.',
  ],
  'error.mfa_not_started': [
    'Pendaftaran verifikasi dua langkah belum dimulai.',
    'Two-step verification setup has not been started.',
  ],
  'recovery.enrol_mfa': [
    'Buka Perangkat & Sesi untuk mengaktifkan verifikasi dua langkah.',
    'Open Devices & Sessions to set up two-step verification.',
  ],
  'recovery.try_code_again': [
    'Periksa kode terbaru di aplikasi autentikator Anda.',
    'Check the latest code in your authenticator app.',
  ],
  'recovery.login_again': ['Masuk kembali untuk memulai ulang.', 'Sign in again to start over.'],
  'recovery.enter_transfer_otp': [
    'Kode verifikasi dikirim ke email terdaftar Anda. Masukkan kode itu untuk melanjutkan.',
    'A verification code was sent to your registered email. Enter it to continue.',
  ],
  'recovery.awaiting_admin_approval': [
    'Kode terverifikasi. Permintaan Anda menunggu persetujuan Admin.',
    'Code verified. Your request is awaiting Admin approval.',
  ],
  'error.transfer_otp_invalid': ['Kode verifikasi tidak cocok.', 'The verification code does not match.'],
  'error.transfer_not_pending': [
    'Permintaan pemindahan sudah tidak berlaku.',
    'The transfer request is no longer valid.',
  ],
  'error.device_not_bound': [
    'Akun ini sudah terikat perangkat lain.',
    'This account is already bound to another device.',
  ],
  'error.impossible_travel': [
    'Login diblokir sementara — terdeteksi akses dari dua lokasi yang mustahil ditempuh.',
    'Sign-in temporarily blocked — access detected from two implausibly distant locations.',
  ],
  'error.session_invalid': ['Sesi tidak berlaku.', 'Session is not valid.'],
  'error.session_expired': ['Sesi berakhir. Masuk kembali untuk melanjutkan.', 'Session expired. Sign in again to continue.'],
  'error.session_revoked': ['Sesi diakhiri dari perangkat lain.', 'Session was ended from another device.'],
  'error.session_idle_timeout': [
    'Sesi berakhir karena tidak ada aktivitas.',
    'Session ended due to inactivity.',
  ],
  'error.unauthenticated': ['Masuk untuk melanjutkan.', 'Sign in to continue.'],
  'error.forbidden': ['Peran Anda tidak memiliki akses ke tindakan ini.', 'Your role does not have access to this action.'],
  'error.reauth_required': [
    'Tindakan ini menuntut konfirmasi kata sandi ulang.',
    'This action requires re-entering your password.',
  ],
  'error.not_found': ['Data tidak ditemukan.', 'Not found.'],
  'error.module_not_in_plan': [
    'Modul ini tidak tersedia pada paket langganan saat ini.',
    'This module is not available on your current plan.',
  ],
  'error.tenant_read_only': [
    'Ruang kerja dalam mode baca-saja. Selesaikan pembayaran untuk mengaktifkan kembali.',
    'Workspace is in read-only mode. Settle payment to restore full access.',
  ],
  'error.subscription_expired': [
    'Masa berlaku langganan sudah habis. Data Anda tetap dapat dilihat dan diunduh, tetapi perubahan dihentikan.',
    'Your subscription has expired. Your data stays readable and downloadable, but changes are on hold.',
  ],
  'error.registration_pending_approval': [
    'Pendaftaran Anda sedang menunggu persetujuan admin. Anda akan diberi kabar lewat email begitu diputuskan.',
    'Your registration is waiting for admin approval. You will be emailed once a decision is made.',
  ],
  'error.registration_rejected': [
    'Pendaftaran ini tidak disetujui, sehingga ruang kerjanya tidak dapat dibuka.',
    'This registration was not approved, so the workspace cannot be opened.',
  ],
  'error.registration_already_decided': [
    'Pendaftaran ini sudah pernah diputuskan.',
    'This registration has already been decided.',
  ],
  'error.rejection_reason_required': [
    'Alasan penolakan wajib diisi — pendaftar berhak tahu mengapa.',
    'A rejection reason is required — the applicant deserves to know why.',
  ],
  'recovery.wait_for_approval': [
    'Tidak ada yang perlu Anda lakukan. Hubungi admin bila lebih dari satu hari kerja belum ada kabar.',
    'Nothing to do on your side. Contact the admin if you hear nothing within one business day.',
  ],
  'error.billing_cycle_unknown': [
    'Jangka waktu berlangganan tidak dikenali.',
    'That subscription term is not recognised.',
  ],
  'error.subscription_unpaid': [
    'Ruang kerja ini belum aktif — pembayaran pertama belum tercatat. Data dapat dilihat dan diunduh, tetapi perubahan belum dapat disimpan.',
    'This workspace is not active yet — no first payment has been recorded. Data can be viewed and downloaded, but changes cannot be saved yet.',
  ],
  'recovery.activate_subscription': [
    'Buka Manajemen Langganan & Paket untuk menyelesaikan pembayaran. Hubungi admin bila pembayaran sudah dikirim tetapi belum tercatat.',
    'Open Subscription Management to complete payment. Contact the admin if you have paid but it is not recorded yet.',
  ],
  'recovery.renew_subscription': [
    'Buka Manajemen Langganan & Paket, lalu perpanjang untuk membuka kembali penulisan.',
    'Open Subscription Management and renew to restore write access.',
  ],
  'error.quota_exceeded': ['Kuota paket terlampaui.', 'Plan quota exceeded.'],
  'error.rate_limited': ['Terlalu banyak permintaan. Coba lagi sebentar lagi.', 'Too many requests. Try again shortly.'],
  'error.dq_below_threshold': [
    'Skor kualitas di bawah ambang batas — dataset tidak dapat disertifikasi.',
    'Quality score is below the threshold — this dataset cannot be certified.',
  ],
  'error.dq_run_required': [
    'Jalankan pemeriksaan kualitas sebelum sertifikasi.',
    'Run a quality check before certifying.',
  ],
  'error.export_requires_steward_approval': [
    'Dataset Restricted memerlukan persetujuan Data Steward sebelum diekspor.',
    'Restricted datasets require Data Steward approval before export.',
  ],
  'error.restricted_cannot_embed': [
    'Dashboard berklasifikasi Restricted tidak dapat disematkan.',
    'Restricted dashboards cannot be embedded.',
  ],
  'error.dashboard_not_published': [
    'Publikasikan dashboard terlebih dahulu sebelum membuat token sematan.',
    'Publish the dashboard before creating an embed token.',
  ],
  'error.domain_whitelist_required': [
    'Tetapkan minimal satu domain yang diizinkan.',
    'Specify at least one allowed domain.',
  ],
  'error.cannot_change_own_access': [
    'Hak akses sendiri tidak dapat diubah dari layar ini.',
    'You cannot change your own access from this screen.',
  ],
  'error.cannot_approve_own_change': [
    'Perubahan yang Anda ajukan harus disetujui pengguna lain.',
    'A change you proposed must be approved by someone else.',
  ],
  'error.employee_required': [
    'Akun harus terhubung ke satu entri Master Pegawai.',
    'An account must be linked to a Master Pegawai record.',
  ],
  'error.employee_nik_exists': ['NIK sudah terdaftar.', 'This employee ID is already registered.'],
  'error.user_email_exists': ['Email sudah dipakai akun lain.', 'This email is already in use.'],
  'error.password_too_short': ['Kata sandi minimal 12 karakter.', 'Password must be at least 12 characters.'],
  'error.password_needs_letter': ['Kata sandi harus memuat huruf.', 'Password must contain a letter.'],
  'error.password_needs_digit': ['Kata sandi harus memuat angka.', 'Password must contain a digit.'],
  'error.password_needs_symbol': ['Kata sandi harus memuat simbol.', 'Password must contain a symbol.'],
  'error.signup_disabled': [
    'Pendaftaran mandiri sedang ditutup pada instalasi ini. Hubungi administrator untuk dibuatkan akun.',
    'Self-service signup is closed on this installation. Contact your administrator for an account.',
  ],
  'error.signup_incomplete': [
    'Lengkapi seluruh kolom sebelum melanjutkan.',
    'Fill in every field before continuing.',
  ],
  'error.reset_token_invalid': [
    'Kode pemulihan tidak berlaku, sudah dipakai, atau kedaluwarsa. Ajukan permintaan baru.',
    'The recovery code is invalid, already used, or expired. Request a new one.',
  ],
  'error.email_required': ['Alamat email harus diisi.', 'Email address is required.'],
  'error.tenant_slug_taken': [
    'Alamat ruang kerja itu sudah dipakai organisasi lain. Pilih yang lain.',
    'That workspace address is already taken. Choose another.',
  ],
  'error.invalid_tenant_slug': [
    'Alamat ruang kerja hanya boleh huruf kecil, angka, dan tanda hubung.',
    'Workspace address may contain only lowercase letters, digits, and hyphens.',
  ],
  'error.plan_unknown': ['Paket yang dipilih tidak dikenali.', 'The selected plan is not recognised.'],
  'error.password_confirm_mismatch': [
    'Konfirmasi tidak sama dengan kata sandi baru.',
    'Confirmation does not match the new password.',
  ],
  'error.use_self_password_change': [
    'Untuk akun sendiri, gunakan Ganti Kata Sandi di halaman profil — kata sandi lama diperlukan.',
    'For your own account, use Change Password on your profile page — your current password is required.',
  ],
  'error.password_reused': [
    'Kata sandi tidak boleh sama dengan 5 kata sandi terakhir.',
    'Password cannot match any of your last 5 passwords.',
  ],
  'error.connection_locked': [
    'Koneksi terkunci sementara setelah kegagalan autentikasi berulang.',
    'Connection temporarily locked after repeated authentication failures.',
  ],
  'error.connection_credential_required': ['Kredensial koneksi belum lengkap.', 'Connection credentials are incomplete.'],
  'error.connection_host_required': ['Host wajib diisi.', 'Host is required.'],
  'error.connection_url_required': ['URL wajib diisi.', 'URL is required.'],
  'error.connection_database_required': ['Nama basis data wajib diisi.', 'Database name is required.'],
  'error.connection_username_required': ['Nama pengguna wajib diisi.', 'Username is required.'],
  'error.no_certified_dataset': [
    'Belum ada dataset tersertifikasi untuk dijadikan sumber jawaban.',
    'No certified dataset is available to answer from.',
  ],
  'error.metric_not_recognised': [
    'Metrik pada pertanyaan tidak dikenali di semantic layer.',
    'The metric in your question is not recognised in the semantic layer.',
  ],
  'error.field_not_numeric': ['Kolom yang dipilih bukan kolom angka.', 'The selected column is not numeric.'],
  'error.two_groups_required': ['Uji ini memerlukan tepat dua kelompok.', 'This test requires exactly two groups.'],
  'error.anova_needs_three_groups': [
    'ANOVA memerlukan minimal tiga kelompok — gunakan uji t untuk dua kelompok.',
    'ANOVA requires at least three groups — use a t-test for two groups.',
  ],
  'error.insufficient_observations': [
    'Jumlah observasi tidak cukup untuk jumlah prediktor yang dipilih.',
    'Not enough observations for the number of predictors selected.',
  ],
  'error.series_too_short': ['Deret data terlalu pendek untuk diproyeksikan.', 'The series is too short to forecast.'],
  'error.downgrade_exceeds_new_quota': [
    'Konfigurasi saat ini melebihi kuota paket tujuan.',
    'Your current configuration exceeds the target plan quota.',
  ],
  'error.internal': ['Terjadi kesalahan pada sistem.', 'A system error occurred.'],

  /* ---------------- Pemulihan (SECURITY.md 17.4) ---------------- */
  'recovery.request_device_transfer': [
    'Ajukan pemindahan perangkat ke Admin untuk memakai perangkat ini.',
    'Request a device transfer from your Admin to use this device.',
  ],
  'recovery.contact_admin': ['Hubungi Admin sistem organisasi Anda.', 'Contact your system administrator.'],
  'recovery.wait_or_contact_admin': [
    'Tunggu hingga waktu penguncian berakhir, atau hubungi Admin.',
    'Wait until the lockout expires, or contact your Admin.',
  ],

  /* ---------------- Navigasi & domain ---------------- */
  // Nama DOMAIN boleh diterjemahkan (pengelompokan navigasi) — BRAND.md Bagian 7.
  'domain.leadership': ['Kepemimpinan', 'Leadership'],
  'domain.visualization': ['Visualisasi & Pelaporan', 'Visualization & Reporting'],
  'domain.ai': ['Analitik Cerdas (AI)', 'Intelligent Analytics (AI)'],
  'domain.statistics': ['Analisis Statistik', 'Statistical Analysis'],
  'domain.data': ['Manajemen Data', 'Data Management'],
  'domain.monitoring': ['Monitoring & Notifikasi', 'Monitoring & Notifications'],
  'domain.administration': ['Administrasi Sistem', 'System Administration'],
  'domain.billing': ['Langganan & Billing', 'Subscription & Billing'],

  /* ---------------- Kualitas data ---------------- */
  'dq.duplicate_rows': ['Baris duplikat terdeteksi', 'Duplicate rows detected'],
  'dq.missing_values': ['Nilai kosong pada kolom', 'Missing values in column'],
  'dq.invalid_values': ['Nilai tidak sesuai tipe kolom', 'Values do not match the column type'],
  'dq.no_issues': ['Tidak ditemukan masalah kualitas.', 'No quality issues found.'],

  /* ---------------- AI ---------------- */
  'ai.banner_eyebrow': ['Ringkasan AI Narrative', 'AI Narrative Summary'],
  'ai.copilot_title': ['AI Copilot', 'AI Copilot'],
  'ai.ask_placeholder': ['Tanyakan tentang data Anda…', 'Ask about your data…'],
  'ai.sources_label': ['Sumber data', 'Data sources'],
  'ai.narrative.increase': [
    'Total {metric} tercatat {total}, dengan kontributor terbesar {topLabel} sebesar {topShare}% dari keseluruhan.',
    'Total {metric} is {total}, with {topLabel} the largest contributor at {topShare}% of the whole.',
  ],
  'ai.narrative.decrease': [
    'Total {metric} tercatat {total}. Penurunan paling terlihat pada {topLabel} ({topShare}% dari total).',
    'Total {metric} is {total}. The decline is most visible in {topLabel} ({topShare}% of total).',
  ],
  'ai.narrative.compare': [
    'Perbandingan {metric} per {dimension}: {topLabel} memimpin dengan {topShare}% dari total {total}.',
    'Comparing {metric} by {dimension}: {topLabel} leads with {topShare}% of the {total} total.',
  ],
  'ai.narrative.describe': [
    '{metric} bernilai {total} atas {rows} baris data, dipecah menurut {dimension}.',
    '{metric} totals {total} across {rows} rows, broken down by {dimension}.',
  ],
  'ai.deterministic_summary': [
    'Ringkasan disusun dari agregat terhitung, tanpa mengirim data ke penyedia AI eksternal.',
    'Summary composed from computed aggregates, without sending data to an external AI provider.',
  ],

  /* ---------------- RCA ---------------- */
  'rca.draft_requires_human_validation': [
    'Draf otomatis — perlu ditinjau dan divalidasi analis sebelum menjadi catatan resmi.',
    'Automated draft — requires analyst review and validation before becoming an official record.',
  ],
  'rca.category.people': ['Manusia', 'People'],
  'rca.category.process': ['Proses', 'Process'],
  'rca.category.system': ['Sistem', 'System'],
  'rca.category.data': ['Data', 'Data'],
  'rca.category.environment': ['Lingkungan', 'Environment'],
  'rca.category.policy': ['Kebijakan', 'Policy'],
  'rca.why_1': ['Mengapa hal ini terjadi?', 'Why did this happen?'],
  'rca.why_2': ['Mengapa penyebab itu muncul?', 'Why did that cause arise?'],
  'rca.why_3': ['Mengapa kondisi itu dibiarkan?', 'Why was that condition allowed?'],
  'rca.why_4': ['Mengapa kontrolnya tidak berjalan?', 'Why did the control not work?'],
  'rca.why_5': ['Mengapa akar ini belum tertangani?', 'Why has this root cause not been addressed?'],

  /* ---------------- Digital Twin ---------------- */
  'twin.simulation_is_projection_only': [
    'Hasil simulasi adalah proyeksi — tidak ada perubahan yang diterapkan ke aset. Keputusan tetap pada Anda.',
    'Simulation results are projections — no change is applied to any asset. The decision remains yours.',
  ],
  'twin.low_confidence_warning': [
    'Prediksi berkeyakinan rendah — perlakukan sebagai indikasi awal, bukan kepastian.',
    'Low-confidence prediction — treat as an early indication, not a certainty.',
  ],
  'twin.reason_critical_status': ['Status aset kritis', 'Asset status is critical'],
  'twin.reason_failure_predicted': ['Kegagalan diprediksi dalam waktu dekat', 'Failure predicted in the near term'],
  'twin.reason_low_confidence_prediction': ['Prediksi berkeyakinan rendah', 'Low-confidence prediction'],
  'twin.reason_health_declining': ['Skor kesehatan menurun', 'Health score is declining'],
  'twin.sim_shutdown': ['Aset dihentikan untuk pemeliharaan', 'Asset stopped for maintenance'],
  'twin.sim_increase_load': ['Beban aset dinaikkan', 'Asset load increased'],
  'twin.sim_reduce_load': ['Beban aset diturunkan', 'Asset load reduced'],
  'twin.health_score': ['Skor Kesehatan', 'Health Score'],
  'twin.prediction_window': ['Rentang Perkiraan Kegagalan', 'Predicted Failure Window'],
  'twin.confidence': ['Tingkat Keyakinan', 'Confidence'],

  /* ---------------- Statistik ---------------- */
  'stats.mean': ['Rata-rata', 'Mean'],
  'stats.median': ['Median', 'Median'],
  'stats.mode': ['Modus', 'Mode'],
  'stats.std_dev': ['Standar Deviasi', 'Std. Deviation'],
  'stats.variance': ['Varians', 'Variance'],
  'stats.range': ['Rentang', 'Range'],
  'stats.iqr': ['IQR', 'IQR'],
  'stats.skewness': ['Skewness', 'Skewness'],
  'stats.kurtosis': ['Kurtosis', 'Kurtosis'],
  'stats.n': ['Jumlah Data (N)', 'Count (N)'],
  'stats.missing': ['Nilai Hilang', 'Missing'],
  'stats.distinct': ['Nilai Unik', 'Distinct'],
  'stats.p_value': ['Nilai-p', 'p-value'],
  'stats.statistic': ['Statistik Uji', 'Test Statistic'],
  'stats.df': ['Derajat Kebebasan', 'Degrees of Freedom'],
  'stats.effect_size': ['Effect Size', 'Effect Size'],
  'stats.alpha': ['Tingkat Signifikansi (α)', 'Significance Level (α)'],
  'stats.assumptions': ['Pemeriksaan Asumsi', 'Assumption Checks'],
  'stats.confidence_interval': ['Interval Kepercayaan', 'Confidence Interval'],
  'stats.significant': ['Signifikan secara statistik', 'Statistically significant'],
  'stats.not_significant': ['Tidak signifikan secara statistik', 'Not statistically significant'],

  'assumption.normality': ['Normalitas (Shapiro-Wilk)', 'Normality (Shapiro-Wilk)'],
  'assumption.homogeneity': ['Homogenitas Varians (Levene)', 'Homogeneity of Variance (Levene)'],
  'assumption.independence': ['Independensi Observasi', 'Independence of Observations'],
  'assumption.symmetry': ['Simetri Distribusi Selisih', 'Symmetry of Differences'],
  'assumption.expected_frequency': ['Frekuensi Harapan ≥ 5', 'Expected Frequency ≥ 5'],
  'assumption.passed': ['Terpenuhi', 'Met'],
  'assumption.violated': ['Dilanggar', 'Violated'],

  'warning.normality_violated': [
    'Asumsi normalitas dilanggar — pertimbangkan uji non-parametrik.',
    'Normality assumption violated — consider a non-parametric test.',
  ],
  'warning.homogeneity_violated': [
    'Asumsi homogenitas varians dilanggar.',
    'Homogeneity of variance assumption violated.',
  ],
  'warning.homogeneity_violated_welch_applied': [
    'Varians tidak homogen — koreksi Welch diterapkan otomatis.',
    'Variances are not homogeneous — Welch correction applied automatically.',
  ],
  'warning.small_sample': ['Ukuran sampel kecil — tafsirkan dengan hati-hati.', 'Small sample size — interpret with caution.'],
  'warning.small_sample_normal_approx': [
    'Sampel kecil untuk aproksimasi normal — nilai-p bersifat perkiraan.',
    'Small sample for the normal approximation — the p-value is approximate.',
  ],
  'warning.consider_kruskal_wallis': [
    'Pertimbangkan uji Kruskal-Wallis sebagai alternatif.',
    'Consider the Kruskal-Wallis test as an alternative.',
  ],
  'warning.low_expected_frequencies': [
    'Sebagian sel memiliki frekuensi harapan di bawah 5.',
    'Some cells have expected frequencies below 5.',
  ],
  'warning.severe_multicollinearity': [
    'Multikolinearitas berat (VIF > 10) — koefisien sulit ditafsirkan.',
    'Severe multicollinearity (VIF > 10) — coefficients are hard to interpret.',
  ],
  'warning.moderate_multicollinearity': ['Multikolinearitas sedang (VIF > 5).', 'Moderate multicollinearity (VIF > 5).'],
  'warning.autocorrelation_detected': [
    'Indikasi autokorelasi residual (Durbin-Watson di luar 1.5–2.5).',
    'Residual autocorrelation indicated (Durbin-Watson outside 1.5–2.5).',
  ],
  'warning.influential_points_detected': [
    'Terdapat outlier berpengaruh pada model.',
    'Influential outliers detected in the model.',
  ],
  'warning.residuals_not_normal': ['Residual tidak berdistribusi normal.', 'Residuals are not normally distributed.'],
  'warning.model_did_not_converge': ['Model tidak konvergen.', 'The model did not converge.'],
  'warning.few_events_per_predictor': [
    'Jumlah peristiwa per prediktor rendah — estimasi kurang stabil.',
    'Few events per predictor — estimates are less stable.',
  ],
  'warning.short_history_forecast': [
    'Riwayat data pendek — proyeksi kurang andal.',
    'Short data history — the projection is less reliable.',
  ],
  'warning.high_forecast_error': [
    'Galat proyeksi tinggi (MAPE > 30%).',
    'High forecast error (MAPE > 30%).',
  ],
  'warning.insufficient_replication': [
    'Replikasi tidak cukup untuk menguji interaksi.',
    'Insufficient replication to test the interaction.',
  ],

  // Pembedaan asosiasi vs kausalitas — WAJIB eksplisit (PRD 6.23 & 6.24).
  'note.difference_not_causation': [
    'Uji ini menunjukkan ada tidaknya PERBEDAAN antar-kelompok, bukan bahwa satu hal MENYEBABKAN yang lain.',
    'This test shows whether a DIFFERENCE exists between groups, not that one thing CAUSES another.',
  ],
  'note.association_not_causation': [
    'Hasil ini menunjukkan ASOSIASI antar-variabel, bukan hubungan sebab-akibat.',
    'This result shows an ASSOCIATION between variables, not a cause-and-effect relationship.',
  ],
  'note.correlation_not_causation': [
    'Korelasi bukan kausalitas — dua variabel yang bergerak bersama belum tentu saling menyebabkan.',
    'Correlation is not causation — two variables moving together do not necessarily cause each other.',
  ],
  'note.regression_not_causation': [
    'Regresi atas data observasional tidak membuktikan sebab-akibat; koefisien menggambarkan hubungan, bukan pengaruh kausal.',
    'Regression on observational data does not prove causation; coefficients describe association, not causal effect.',
  ],

  'effect.cohens_d': ["Cohen's d", "Cohen's d"],
  'effect.eta_squared': ['Eta-squared (η²)', 'Eta-squared (η²)'],
  'effect.epsilon_squared': ['Epsilon-squared (ε²)', 'Epsilon-squared (ε²)'],
  'effect.cramers_v': ["Cramér's V", "Cramér's V"],
  'effect.cohens_w': ["Cohen's w", "Cohen's w"],
  'effect.rank_biserial': ['Korelasi Rank-Biserial', 'Rank-Biserial Correlation'],
  'effect.r': ['r', 'r'],
  'effect.negligible': ['Dapat diabaikan', 'Negligible'],
  'effect.small': ['Kecil', 'Small'],
  'effect.medium': ['Sedang', 'Medium'],
  'effect.large': ['Besar', 'Large'],

  'correlation.pearson': ['Pearson', 'Pearson'],
  'correlation.spearman': ['Spearman', 'Spearman'],
  'correlation.kendall': ['Kendall', 'Kendall'],
  'strength.very_weak': ['Sangat lemah', 'Very weak'],
  'strength.weak': ['Lemah', 'Weak'],
  'strength.moderate': ['Sedang', 'Moderate'],
  'strength.strong': ['Kuat', 'Strong'],
  'strength.very_strong': ['Sangat kuat', 'Very strong'],

  'test.one_sample_t': ['One-Sample t-Test', 'One-Sample t-Test'],
  'test.independent_t': ['Independent t-Test', 'Independent t-Test'],
  'test.welch_t': ["Welch's t-Test", "Welch's t-Test"],
  'test.paired_t': ['Paired t-Test', 'Paired t-Test'],
  'test.one_way_anova': ['One-Way ANOVA', 'One-Way ANOVA'],
  'test.two_way_anova': ['Two-Way ANOVA', 'Two-Way ANOVA'],
  'test.mann_whitney': ['Mann-Whitney U', 'Mann-Whitney U'],
  'test.wilcoxon': ['Wilcoxon Signed-Rank', 'Wilcoxon Signed-Rank'],
  'test.kruskal_wallis': ['Kruskal-Wallis', 'Kruskal-Wallis'],
  'test.chi_square_independence': ['Chi-Square (Independensi)', 'Chi-Square (Independence)'],
  'test.chi_square_goodness_of_fit': ['Chi-Square (Goodness-of-Fit)', 'Chi-Square (Goodness-of-Fit)'],
  'test.welch_or_kruskal': ['Welch atau Kruskal-Wallis', 'Welch or Kruskal-Wallis'],
  'test.fisher_exact': ['Fisher Exact Test', 'Fisher Exact Test'],

  'interpret.one_sample_t.significant': [
    'Rata-rata sampel ({mean}) berbeda signifikan dari nilai acuan {mu} pada α = {alpha} (p = {pValue}).',
    'The sample mean ({mean}) differs significantly from the reference value {mu} at α = {alpha} (p = {pValue}).',
  ],
  'interpret.one_sample_t.not_significant': [
    'Rata-rata sampel ({mean}) tidak berbeda signifikan dari {mu} pada α = {alpha} (p = {pValue}).',
    'The sample mean ({mean}) does not differ significantly from {mu} at α = {alpha} (p = {pValue}).',
  ],
  'interpret.independent_t.significant': [
    'Rata-rata {groupA} ({meanA}) berbeda signifikan dari {groupB} ({meanB}) pada α = {alpha} (p = {pValue}).',
    'The mean of {groupA} ({meanA}) differs significantly from {groupB} ({meanB}) at α = {alpha} (p = {pValue}).',
  ],
  'interpret.independent_t.not_significant': [
    'Tidak ada perbedaan signifikan antara {groupA} ({meanA}) dan {groupB} ({meanB}) pada α = {alpha} (p = {pValue}).',
    'No significant difference between {groupA} ({meanA}) and {groupB} ({meanB}) at α = {alpha} (p = {pValue}).',
  ],
  'interpret.paired_t.significant': [
    'Rata-rata selisih berpasangan {meanDifference} berbeda signifikan dari nol (p = {pValue}, α = {alpha}).',
    'The mean paired difference of {meanDifference} differs significantly from zero (p = {pValue}, α = {alpha}).',
  ],
  'interpret.paired_t.not_significant': [
    'Rata-rata selisih berpasangan {meanDifference} tidak berbeda signifikan dari nol (p = {pValue}, α = {alpha}).',
    'The mean paired difference of {meanDifference} does not differ significantly from zero (p = {pValue}, α = {alpha}).',
  ],
  'interpret.anova.significant': [
    'Terdapat perbedaan signifikan di antara {groups} kelompok (F = {fStatistic}, p = {pValue}, α = {alpha}).',
    'A significant difference exists among the {groups} groups (F = {fStatistic}, p = {pValue}, α = {alpha}).',
  ],
  'interpret.anova.not_significant': [
    'Tidak ada perbedaan signifikan di antara {groups} kelompok (F = {fStatistic}, p = {pValue}, α = {alpha}).',
    'No significant difference among the {groups} groups (F = {fStatistic}, p = {pValue}, α = {alpha}).',
  ],
  'interpret.mann_whitney.significant': [
    'Distribusi kedua kelompok berbeda signifikan (U = {u}, z = {zScore}, p = {pValue}).',
    'The two group distributions differ significantly (U = {u}, z = {zScore}, p = {pValue}).',
  ],
  'interpret.mann_whitney.not_significant': [
    'Distribusi kedua kelompok tidak berbeda signifikan (U = {u}, z = {zScore}, p = {pValue}).',
    'The two group distributions do not differ significantly (U = {u}, z = {zScore}, p = {pValue}).',
  ],
  'interpret.wilcoxon.significant': [
    'Selisih berpasangan berbeda signifikan dari nol (W = {w}, p = {pValue}).',
    'The paired differences differ significantly from zero (W = {w}, p = {pValue}).',
  ],
  'interpret.wilcoxon.not_significant': [
    'Selisih berpasangan tidak berbeda signifikan dari nol (W = {w}, p = {pValue}).',
    'The paired differences do not differ significantly from zero (W = {w}, p = {pValue}).',
  ],
  'interpret.kruskal.significant': [
    'Terdapat perbedaan signifikan di antara {groups} kelompok (H = {h}, p = {pValue}).',
    'A significant difference exists among the {groups} groups (H = {h}, p = {pValue}).',
  ],
  'interpret.kruskal.not_significant': [
    'Tidak ada perbedaan signifikan di antara {groups} kelompok (H = {h}, p = {pValue}).',
    'No significant difference among the {groups} groups (H = {h}, p = {pValue}).',
  ],
  'interpret.chi_square.significant': [
    'Terdapat asosiasi signifikan antar-variabel (χ² = {chiSquare}, df = {df}, p = {pValue}).',
    'A significant association exists between the variables (χ² = {chiSquare}, df = {df}, p = {pValue}).',
  ],
  'interpret.chi_square.not_significant': [
    'Tidak ada asosiasi signifikan antar-variabel (χ² = {chiSquare}, df = {df}, p = {pValue}).',
    'No significant association between the variables (χ² = {chiSquare}, df = {df}, p = {pValue}).',
  ],
  'interpret.gof.significant': [
    'Distribusi teramati berbeda signifikan dari distribusi harapan (χ² = {chiSquare}, df = {df}, p = {pValue}).',
    'The observed distribution differs significantly from the expected one (χ² = {chiSquare}, df = {df}, p = {pValue}).',
  ],
  'interpret.gof.not_significant': [
    'Distribusi teramati sesuai dengan distribusi harapan (χ² = {chiSquare}, df = {df}, p = {pValue}).',
    'The observed distribution matches the expected one (χ² = {chiSquare}, df = {df}, p = {pValue}).',
  ],

  'model.linear_regression': ['Regresi Linear', 'Linear Regression'],
  'model.logistic_regression': ['Regresi Logistik', 'Logistic Regression'],
  'dw.no_autocorrelation': ['Tidak ada indikasi autokorelasi', 'No autocorrelation indicated'],
  'dw.positive_autocorrelation': ['Indikasi autokorelasi positif', 'Positive autocorrelation indicated'],
  'dw.negative_autocorrelation': ['Indikasi autokorelasi negatif', 'Negative autocorrelation indicated'],
  'vif.acceptable': ['Multikolinearitas dapat diterima', 'Multicollinearity acceptable'],
  'vif.moderate': ['Multikolinearitas sedang', 'Moderate multicollinearity'],
  'vif.severe': ['Multikolinearitas berat', 'Severe multicollinearity'],

  /* ---------------- Narrative ---------------- */
  'narrative.section.overview': ['Ringkasan', 'Overview'],
  'narrative.section.dominant_changes': ['Perubahan Dominan', 'Dominant Changes'],
  'narrative.section.attention': ['Perlu Perhatian', 'Needs Attention'],
  'narrative.fact.kpi_count': [
    '{total} KPI dipantau: {improved} membaik, {declined} menurun.',
    '{total} KPIs tracked: {improved} improved, {declined} declined.',
  ],
  'narrative.fact.kpi_movement': [
    '{kpi} bergerak dari {previous} ke {current} ({deltaPercent}%), status {status}.',
    '{kpi} moved from {previous} to {current} ({deltaPercent}%), status {status}.',
  ],
  'narrative.fact.kpi_off_track': [
    '{kpi} berstatus {status} pada nilai {current}.',
    '{kpi} is {status} at {current}.',
  ],
  'narrative.recommendation.investigate_kpi': [
    'Telusuri penyebab perubahan {kpi} ({deltaPercent}%) melalui Root Cause Analysis.',
    'Investigate the driver behind the {deltaPercent}% change in {kpi} using Root Cause Analysis.',
  ],

  /* ---------------- Alert ---------------- */
  'alert.threshold_breached': ['Ambang batas terlampaui', 'Threshold breached'],

  /* ---------------- Umum UI ---------------- */
  'ui.search_placeholder': ['Cari dashboard, KPI, laporan…', 'Search dashboards, KPIs, reports…'],
  'ui.theme_light': ['Mode Terang', 'Light Mode'],
  'ui.theme_dark': ['Mode Gelap', 'Dark Mode'],
  'ui.language': ['Bahasa', 'Language'],
  'ui.this_month': ['Bulan Ini', 'This Month'],
  'ui.quarter': ['Kuartal', 'Quarter'],
  'ui.year': ['Tahun', 'Year'],
  'ui.loading': ['Memuat…', 'Loading…'],
  'ui.certified_only_note': [
    'Data pada halaman ini hanya bersumber dari dataset berstatus Certified (Data Quality Center).',
    'Data on this page comes only from Certified datasets (Data Quality Center).',
  ],
  'ui.rls_active': [
    'Tampilan dibatasi Row-Level Security peran Anda: {dimensions}.',
    'View restricted by your role Row-Level Security: {dimensions}.',
  ],
  'ui.scope_dimension': ['Cakupan: {scope}', 'Scope: {scope}'],
  'ui.read_only_banner': [
    'Ruang kerja dalam mode baca-saja — perubahan dinonaktifkan sementara.',
    'Workspace is read-only — changes are temporarily disabled.',
  ],
  'ui.plan_label': ['Paket', 'Plan'],
  'ui.overall_score': ['Skor Keseluruhan', 'Overall Score'],
  'ui.updated_at': ['Diperbarui', 'Updated'],
  'ui.showing_rows': ['Menampilkan {shown} dari {total} baris', 'Showing {shown} of {total} rows'],
  'ui.rls_filtered_rows': [
    '{count} baris disembunyikan oleh Row-Level Security.',
    '{count} rows hidden by Row-Level Security.',
  ],
  'ui.attribution': ['Ditenagai oleh Vantik Analytics', 'Powered by Vantik Analytics'],
  'ui.login_title': ['Masuk ke Vantik Analytics', 'Sign in to Vantik Analytics'],
  /* ---------------- Halaman depan & berlangganan ---------------- */
  'ui.landing_eyebrow': ['Platform Analitik Perusahaan', 'Enterprise Analytics Platform'],
  'ui.landing_headline': [
    'Keputusan yang dapat ditelusuri sampai ke angkanya.',
    'Decisions you can trace all the way back to the numbers.',
  ],
  'ui.landing_sub': [
    'Satu tempat untuk data, KPI, analisis statistik, dan pelaporan — dengan jejak audit yang tidak dapat diubah siapa pun, termasuk administrator.',
    'One place for data, KPIs, statistical analysis, and reporting — with an audit trail nobody can alter, administrators included.',
  ],
  'ui.landing_trial_note': [
    'Pendaftaran ditinjau admin lebih dulu. Ruang kerja aktif setelah pembayaran, dan datanya tetap milik Anda.',
    'Registrations are reviewed by an admin first. The workspace activates after payment, and the data stays yours.',
  ],
  'ui.landing_modules_title': ['Yang Anda dapatkan', 'What you get'],
  'ui.landing_modules_sub': [
    '{modules} modul dalam {domains} domain, siap dipakai sejak hari pertama.',
    '{modules} modules across {domains} domains, usable from day one.',
  ],
  'ui.landing_why_title': ['Yang membedakannya', 'What makes it different'],
  'ui.landing_why_1_title': ['Angka yang dapat dipertanggungjawabkan', 'Numbers that hold up'],
  'ui.landing_why_1_body': [
    'Setiap laporan menyatakan sumber data, periode, dan berapa baris yang benar-benar terpakai. Uji statistik menyertakan pemeriksaan asumsinya, bukan hanya nilai-p.',
    'Every report states its data source, period, and how many rows were actually used. Statistical tests report their assumption checks, not just a p-value.',
  ],
  'ui.landing_why_2_title': ['Batas akses yang ditegakkan mesin', 'Access limits the machine enforces'],
  'ui.landing_why_2_body': [
    'Pembatasan baris per pengguna berlaku di level kueri, bukan disembunyikan di antarmuka. Mengubah parameter di peramban tidak memberi data yang bukan haknya.',
    'Row-level limits apply at the query layer, not hidden in the interface. Changing a parameter in the browser does not surface data the user has no right to.',
  ],
  'ui.landing_why_3_title': ['Jejak audit yang tidak dapat dihapus', 'An audit trail that cannot be erased'],
  'ui.landing_why_3_body': [
    'Log Aktivitas tersimpan di basis data terpisah yang menolak setiap perubahan dan penghapusan — termasuk dari Super Admin.',
    'The activity log lives in a separate database that rejects every update and delete — including from a Super Admin.',
  ],
  'ui.landing_why_4_title': ['Dapat dipasang di mana pun', 'Runs where you need it'],
  'ui.landing_why_4_body': [
    'Berjalan di shared hosting cPanel tanpa Docker maupun akses root, dan di server sendiri bila datanya tidak boleh keluar organisasi.',
    'Runs on cPanel shared hosting with no Docker and no root access, and on your own server when the data must not leave the organisation.',
  ],
  'ui.landing_plans_title': ['Paket berlangganan', 'Subscription plans'],
  'ui.landing_plans_sub': [
    'Naik atau turun paket kapan saja; selisihnya dihitung pro-rata.',
    'Move up or down any time; the difference is prorated.',
  ],
  'ui.per_month': ['/bulan', '/month'],
  'ui.plan_annual': ['{price} bila dibayar tahunan', '{price} billed annually'],
  'ui.plan_modules': ['{count} modul aktif', '{count} active modules'],
  'ui.plan_users': ['Pengguna: {value}', 'Users: {value}'],
  'ui.plan_datasets': ['Dataset: {value}', 'Datasets: {value}'],
  'ui.plan_ai': ['Panggilan AI per bulan: {value}', 'AI calls per month: {value}'],
  'ui.signup_title': ['Buat ruang kerja', 'Create your workspace'],
  'ui.signup_sub': [
    'Anda menjadi administrator pertamanya. Pendaftaran ditinjau admin, lalu ruang kerja aktif setelah pembayaran pertama.',
    'You become its first administrator. Registrations are reviewed by an admin, then the workspace activates after the first payment.',
  ],
  'ui.signup_plan': ['Paket', 'Plan'],
  'ui.signup_cycle': ['Jangka waktu berlangganan', 'Subscription term'],
  'ui.signup_cycle_hint': [
    'Semakin panjang jangka waktunya, semakin murah biaya per bulannya.',
    'The longer the term, the lower the monthly cost.',
  ],
  'ui.cycle_monthly': ['1 bulan', '1 month'],
  'ui.cycle_quarterly': ['3 bulan', '3 months'],
  'ui.cycle_semiannual': ['6 bulan', '6 months'],
  'ui.cycle_annual': ['12 bulan', '12 months'],
  'ui.cycle_save': ['hemat {percent}%', 'save {percent}%'],
  'ui.per_cycle': ['/{cycle}', '/{cycle}'],
  'ui.plan_per_month_equivalent': ['Setara {price} per bulan', 'Equivalent to {price} per month'],
  'ui.signup_pending_title': ['Pendaftaran diterima', 'Registration received'],
  'ui.signup_pending_body': [
    'Ruang kerja "{slug}" sudah dibuat dan sedang menunggu persetujuan admin. Anda akan menerima email begitu disetujui — belum perlu mencoba masuk sekarang.',
    'Workspace "{slug}" has been created and is waiting for admin approval. You will get an email once it is approved — there is no need to try signing in yet.',
  ],
  'ui.pending_registrations': ['Pendaftaran menunggu persetujuan', 'Registrations awaiting approval'],
  'ui.pending_none': ['Tidak ada pendaftaran yang menunggu.', 'No registrations are waiting.'],
  'ui.approval_note': ['Catatan / alasan', 'Note / reason'],
  'ui.approval_reject_hint': [
    'Wajib diisi bila menolak; isinya dikirimkan ke pendaftar.',
    'Required when rejecting; the text is sent to the applicant.',
  ],
  'ui.subscription_days_left': ['{days} hari lagi', '{days} days left'],
  'ui.subscription_expired_days': ['Lewat {days} hari', '{days} days overdue'],
  'ui.subscription_expiring_soon': [
    'Masa berlaku berakhir dalam {days} hari. Perpanjang sebelum tanggal itu agar ruang kerja tidak beralih ke mode baca-saja.',
    'Your term ends in {days} days. Renew before then to keep the workspace out of read-only mode.',
  ],
  'ui.subscription_unpaid_hint': [
    'Ruang kerja belum pernah aktif. Selesaikan pembayaran pertama untuk membuka penulisan — data yang sudah ada tetap utuh.',
    'This workspace has never been active. Complete the first payment to unlock writing — existing data stays intact.',
  ],
  'action.activate_for': ['Aktifkan {cycle} — {price}', 'Activate {cycle} — {price}'],
  'ui.subscription_renew_hint': [
    'Perpanjang untuk membuka kembali penulisan. Data Anda tetap utuh selama masa ini.',
    'Renew to restore write access. Your data stays intact throughout.',
  ],
  'action.renew_for': ['Perpanjang {cycle} — {price}', 'Renew {cycle} — {price}'],
  'ui.signup_summary': [
    'Yang akan ditagihkan: {plan}, {price} per {cycle}. Dapat diubah atau dihentikan kapan saja.',
    'What will be billed: {plan}, {price} per {cycle}. Change or cancel any time.',
  ],
  'ui.signup_org': ['Nama organisasi', 'Organisation name'],
  'ui.signup_slug': ['Alamat ruang kerja', 'Workspace address'],
  'ui.signup_slug_hint': [
    'Dipakai saat masuk. Huruf kecil, angka, dan tanda hubung.',
    'Used when signing in. Lowercase letters, digits, and hyphens.',
  ],
  'ui.signup_name': ['Nama Anda', 'Your name'],
  'ui.signup_done_title': ['Ruang kerja siap', 'Your workspace is ready'],
  'ui.signup_done_body': [
    'Masuk memakai kode organisasi "{slug}" beserta email dan kata sandi yang baru saja Anda buat. Ruang kerja dapat dibuka dan dibaca; penulisan terbuka setelah pembayaran pertama tercatat.',
    'Sign in with organisation code "{slug}" and the email and password you just created. The workspace opens and reads fine; writing unlocks once the first payment is recorded.',
  ],
  'ui.forgot_title': ['Lupa kata sandi', 'Forgot password'],
  'ui.forgot_sub': [
    'Masukkan alamat email akun Anda. Bila akunnya ada, kode pemulihan akan dikirimkan.',
    'Enter your account email. If the account exists, a recovery code will be sent.',
  ],
  'ui.forgot_tenant_hint': [
    'Kosongkan bila Anda tidak ingat kode organisasinya.',
    'Leave blank if you do not remember your organisation code.',
  ],
  'ui.forgot_sent_title': ['Permintaan diterima', 'Request received'],
  'ui.forgot_sent_body': [
    'Bila ada akun dengan alamat itu, kode pemulihan sudah dibuat. Kode berlaku 30 menit dan hanya dapat dipakai sekali.',
    'If an account exists for that address, a recovery code has been created. It is valid for 30 minutes and can be used once.',
  ],
  'ui.forgot_no_transport': [
    'Instalasi ini belum memasang pengiriman email, jadi kodenya menunggu di antrean notifikasi. Hubungi administrator untuk mengambilnya.',
    'This installation has no email delivery configured yet, so the code is waiting in the notification queue. Ask your administrator for it.',
  ],
  'ui.reset_title': ['Atur ulang kata sandi', 'Reset your password'],
  'ui.reset_token': ['Kode pemulihan', 'Recovery code'],
  'ui.reset_token_hint': [
    'Dari pesan pemulihan, atau dari administrator Anda.',
    'From the recovery message, or from your administrator.',
  ],
  'ui.reset_done': [
    'Kata sandi berhasil diatur ulang. Seluruh sesi lama sudah dikeluarkan.',
    'Your password has been reset. All previous sessions were signed out.',
  ],

  'ui.password_title': ['Kata Sandi', 'Password'],
  'ui.password_current': ['Kata sandi saat ini', 'Current password'],
  'ui.password_new': ['Kata sandi baru', 'New password'],
  'ui.password_confirm': ['Ulangi kata sandi baru', 'Repeat new password'],
  'ui.password_policy': [
    'Minimal 12 karakter, memuat huruf, angka, dan simbol. Kata sandi yang pernah dipakai ditolak.',
    'At least 12 characters with a letter, a digit, and a symbol. Previously used passwords are rejected.',
  ],
  'ui.password_changed': ['Kata sandi berhasil diganti.', 'Password changed.'],
  'ui.mfa_step_title': ['Verifikasi dua langkah', 'Two-step verification'],
  'ui.mfa_step_hint': [
    'Masukkan kode dari aplikasi autentikator Anda, atau salah satu kode pemulihan.',
    'Enter the code from your authenticator app, or one of your recovery codes.',
  ],
  'ui.mfa_code': ['Kode verifikasi', 'Verification code'],
  'ui.mfa_code_hint': ['6 digit, berlaku 30 detik', '6 digits, valid for 30 seconds'],
  'ui.mfa_title': ['Verifikasi Dua Langkah', 'Two-Step Verification'],
  'ui.mfa_active': ['Verifikasi dua langkah aktif untuk akun ini.', 'Two-step verification is active on this account.'],
  'ui.mfa_optional': [
    'Verifikasi dua langkah belum aktif. Peran Anda tidak mewajibkannya, tetapi tetap dianjurkan.',
    'Two-step verification is off. Your role does not require it, but it is still recommended.',
  ],
  'ui.mfa_scan_hint': [
    'Tambahkan rahasia berikut ke aplikasi autentikator, lalu masukkan kode yang muncul.',
    'Add the secret below to your authenticator app, then enter the code it shows.',
  ],
  'ui.mfa_uri': ['Tampilkan URI otpauth', 'Show otpauth URI'],
  'ui.mfa_recovery_left': ['Kode pemulihan tersisa', 'Recovery codes remaining'],
  'ui.mfa_recovery_once': [
    'Simpan kode pemulihan ini sekarang — kode tidak akan ditampilkan lagi.',
    'Save these recovery codes now — they will not be shown again.',
  ],
  'ui.login_tenant': ['Kode Organisasi', 'Organisation Code'],
  'ui.login_email': ['Email', 'Email'],
  'ui.login_password': ['Kata Sandi', 'Password'],
  'ui.tagline': ['Satu sudut pandang, seluruh organisasi.', 'One vantage point, the whole organisation.'],
  'ui.my_devices': ['Perangkat Saya', 'My Devices'],
  'ui.current_device': ['Perangkat ini', 'This device'],
  'ui.confidence_low': ['Keyakinan rendah', 'Low confidence'],
  'ui.projection_note': ['Proyeksi, bukan kepastian.', 'A projection, not a certainty.'],
} as const satisfies Record<string, readonly [string, string]>;

export type DictionaryKey = keyof typeof dictionary;

/** Semua kunci dijamin punya padanan di kedua bahasa (TESTING.md Bagian 9). */
export const DICTIONARY_KEYS = Object.keys(dictionary) as DictionaryKey[];

export function translate(
  key: string,
  locale: Locale,
  params?: Record<string, string | number>,
): string {
  const entry = (dictionary as Record<string, readonly [string, string]>)[key];
  // Kunci tak dikenal dikembalikan apa adanya agar terlihat jelas saat pengujian,
  // bukan menghilang diam-diam menjadi teks kosong.
  if (!entry) return key;

  let text = locale === 'en' ? entry[1] : entry[0];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
