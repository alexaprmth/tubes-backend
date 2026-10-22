const jsonRequest = (schema = { type: 'object', additionalProperties: true }) => ({
  required: true,
  content: {
    'application/json': { schema }
  }
});

const jsonResponse = (description = 'Berhasil') => ({
  description,
  content: {
    'application/json': {
      schema: { type: 'object', additionalProperties: true }
    }
  }
});

const errorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' }
        }
      }
    }
  }
});

const authOperation = (operation) => ({
  ...operation,
  security: [{ bearerAuth: [] }]
});

const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'ID resource'
};

export const createOpenapiSpec = (serverUrl = 'http://localhost:4100') => ({
  openapi: '3.0.3',
  info: {
    title: 'TransRent API',
    version: '1.0.0',
    description: 'API backend sistem rental kendaraan TransRent.'
  },
  servers: [{ url: serverUrl }],
  tags: [
    { name: 'Health' },
    { name: 'Authentication' },
    { name: 'Catalog & Search' },
    { name: 'Reservations & Payments' },
    { name: 'Rental Operations' },
    { name: 'Inspection, Fine & Refund' },
    { name: 'GPS Tracking' },
    { name: 'Admin' },
    { name: 'Maintenance' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Masukkan access token tanpa atau dengan awalan Bearer.'
      }
    },
    schemas: {
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'customer@transrent.demo' },
          password: { type: 'string', format: 'password', example: 'demo123' }
        }
      },
      RegisterRequest: {
        type: 'object',
        required: ['name', 'email', 'password', 'ktpNumber', 'simNumber'],
        properties: {
          name: { type: 'string', example: 'Budi TransRent' },
          email: { type: 'string', format: 'email', example: 'budi@example.com' },
          password: { type: 'string', format: 'password', example: 'password123' },
          phone: { type: 'string', example: '081234567890' },
          address: { type: 'string', example: 'Denpasar, Bali' },
          ktpNumber: { type: 'string', example: '5103010101010001' },
          simNumber: { type: 'string', example: 'SIM-123456' },
          ktpDocument: { type: 'string', description: 'Data URL dokumen JPG/PNG untuk demo' },
          simDocument: { type: 'string', description: 'Data URL dokumen JPG/PNG untuk demo' }
        }
      },
      ReservationRequest: {
        type: 'object',
        required: ['vehicleId', 'startDate', 'endDate', 'pickupMode'],
        properties: {
          vehicleId: { type: 'string', format: 'uuid' },
          startDate: { type: 'string', format: 'date', example: '2026-09-24' },
          endDate: { type: 'string', format: 'date', example: '2026-09-26' },
          pickupMode: { type: 'string', enum: ['PICKUP', 'DELIVERY'] },
          deliveryAddress: { type: 'string' },
          deliveryLatitude: { type: 'number', format: 'double' },
          deliveryLongitude: { type: 'number', format: 'double' },
          recipientPhone: { type: 'string' },
          deliveryNotes: { type: 'string' }
        }
      },
      LocationRequest: {
        type: 'object',
        required: ['deviceId', 'latitude', 'longitude'],
        properties: {
          deviceId: { type: 'string', example: 'GPS-INNOVA-01' },
          latitude: { type: 'number', format: 'double', example: -8.6884 },
          longitude: { type: 'number', format: 'double', example: 115.2631 },
          speed: { type: 'number', example: 18 },
          heading: { type: 'number', example: 120 }
        }
      },
      VerificationRequest: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['VERIFIED', 'REJECTED', 'PENDING'] }
        }
      },
      MaintenanceRequest: {
        type: 'object',
        required: ['vehicleId', 'title'],
        properties: {
          vehicleId: { type: 'string', format: 'uuid' },
          title: { type: 'string', example: 'Servis berkala' },
          type: { type: 'string', example: 'SERVICE' },
          scheduledAt: { type: 'string', format: 'date-time' },
          notes: { type: 'string' }
        }
      }
    }
  },
  paths: {
"/api/auth/refresh": {"post": {"tags": ["Authentication"], "summary": "Rotasi sesi dengan refreshToken", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"refreshToken": "<refresh token>"}}}}}},
"/api/auth/accept-invite": {"post": {"tags": ["Authentication"], "summary": "Tetapkan password Admin Rental dari callback invite/recovery", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/admin/invitations": {"get": {"tags": ["Admin"], "summary": "Status dan kegagalan undangan; Admin Pusat", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}]}},
"/api/payment-orders": {"get": {"tags": ["Reservations & Payments"], "summary": "Invoice dan receipt sesuai pemilik/perusahaan", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}]}},
"/api/reservations/{id}/checkout": {"post": {"tags": ["Reservations & Payments"], "summary": "Buat/reuse invoice reservasi dengan nominal server", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/rentals/{id}/fine-checkout": {"post": {"tags": ["Inspection, Fine & Refund"], "summary": "Buat/reuse invoice pelunasan selisih denda", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/rentals/{id}/refund/paid": {"post": {"tags": ["Inspection, Fine & Refund"], "summary": "Admin mencatat payout deposit dengan reference; baru menutup rental", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/admin/master": {"get": {"tags": ["Admin"], "summary": "Master cabang, perangkat GPS, kendaraan sesuai lingkup admin", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}]}},
"/api/admin/master/{entity}": {"post": {"tags": ["Admin"], "summary": "Tambah branches/devices/vehicles tanpa kewajiban foto", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "entity", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/admin/master/{entity}/{id}": {"patch": {"tags": ["Admin"], "summary": "Ubah master; kendaraan dengan booking aktif terkunci", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "entity", "in": "path", "required": true, "schema": {"type": "string"}}, {"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/payment-orders/{id}/declare": {"post": {"tags": ["Reservations & Payments"], "summary": "Customer menyatakan pembayaran dengan reference", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/payment-orders/{id}/approve": {"post": {"tags": ["Reservations & Payments"], "summary": "Admin menyetujui DECLARED; PAID dan reservasi atomik", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/payment-orders/{id}/reject": {"post": {"tags": ["Reservations & Payments"], "summary": "Admin menolak DECLARED dengan notes", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},
"/api/payment-orders/{id}/refund": {"post": {"tags": ["Reservations & Payments"], "summary": "Admin mencatat payout pembatalan dengan reference", "responses": {"200": {"description": "Berhasil"}, "400": {"description": "Input tidak valid"}, "403": {"description": "Lingkup/peran ditolak"}, "409": {"description": "Status atau nominal tidak sesuai"}, "503": {"description": "Database belum migration 015 dan 016"}}, "security": [{"bearerAuth": []}], "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": false, "content": {"application/json": {"schema": {"type": "object", "additionalProperties": true}, "example": {"reference": "INTERNAL-REF-001", "notes": "Diperiksa admin"}}}}}},

    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Cek status backend dan koneksi persistence',
        responses: { 200: jsonResponse('Backend aktif') }
      }
    },
    '/api/health/deep': {
      get: {
        tags: ['Health'],
        summary: 'Cek koneksi nyata ke Supabase',
        responses: {
          200: jsonResponse('Backend dan database siap'),
          503: errorResponse('Database tidak dapat dijangkau')
        }
      }
    },
    '/api/auth/demo-login': {
      post: {
        tags: ['Authentication'],
        summary: 'Login akun demo',
        requestBody: jsonRequest({ $ref: '#/components/schemas/LoginRequest' }),
        responses: { 200: jsonResponse('Login demo berhasil'), 401: errorResponse('Login gagal') }
      }
    },
    '/api/auth/login': {
      post: {
        tags: ['Authentication'],
        summary: 'Login melalui Supabase Auth atau mode demo',
        requestBody: jsonRequest({ $ref: '#/components/schemas/LoginRequest' }),
        responses: { 200: jsonResponse('Login berhasil'), 401: errorResponse('Login gagal') }
      }
    },
    '/api/auth/register': {
      post: {
        tags: ['Authentication'],
        summary: 'Registrasi customer',
        requestBody: jsonRequest({ $ref: '#/components/schemas/RegisterRequest' }),
        responses: { 201: jsonResponse('Registrasi berhasil'), 400: errorResponse('Data registrasi tidak valid') }
      }
    },
    '/api/auth/me': {
      get: {
        ...authOperation({ tags: ['Authentication'], summary: 'Membaca user yang sedang login' }),
        responses: { 200: jsonResponse('Data user'), 401: errorResponse('Token tidak valid') }
      }
    },
    '/api/companies': {
      get: {
        tags: ['Catalog & Search'],
        summary: 'Daftar perusahaan rental aktif',
        responses: { 200: jsonResponse('Daftar perusahaan') }
      }
    },
    '/api/branches/search': {
      get: {
        tags: ['Catalog & Search'],
        summary: 'Cari kendaraan berdasarkan lokasi dan periode',
        parameters: [
          { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'startDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['ALL', 'CAR', 'MOTORCYCLE'] } }
        ],
        responses: { 200: jsonResponse('Hasil pencarian') }
      }
    },
    '/api/reservations': {
      get: {
        ...authOperation({ tags: ['Reservations & Payments'], summary: 'Daftar reservasi sesuai role user' }),
        responses: { 200: jsonResponse('Daftar reservasi'), 401: errorResponse('Belum login') }
      },
      post: {
        ...authOperation({ tags: ['Reservations & Payments'], summary: 'Membuat reservasi baru' }),
        requestBody: jsonRequest({ $ref: '#/components/schemas/ReservationRequest' }),
        responses: { 201: jsonResponse('Reservasi dibuat'), 403: errorResponse('Customer belum terverifikasi') }
      }
    },
    '/api/reservations/{id}/payments/simulate': {
      post: {
        ...authOperation({ tags: ['Reservations & Payments'], summary: 'Simulasi pembayaran reservasi', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Pembayaran simulasi berhasil'), 409: errorResponse('Reservasi tidak dapat dibayar') }
      }
    },
    '/api/reservations/{id}/cancel': {
      post: { ...authOperation({ tags: ['Reservations & Payments'], summary: 'Pembatalan sebelum handover dan refund penuh akademik', parameters: [idParameter] }),
        requestBody: jsonRequest({ type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } } }),
        responses: { 200: jsonResponse('Reservasi CANCELLED dan bukti refund simulasi; retry tidak menggandakan refund'), 403: errorResponse('Hanya pemilik/admin perusahaan'), 409: errorResponse('Sudah handover atau provider riil') } }
    },
    '/api/disputes/{id}/resolve': {
      post: { ...authOperation({ tags: ['Inspection, Fine & Refund'], summary: 'Keputusan final sengketa oleh admin perusahaan/pusat', parameters: [idParameter] }),
        requestBody: jsonRequest({ type: 'object', required: ['decision','notes'], properties: { decision: { type: 'string', enum: ['ACCEPTED','REJECTED','ADJUSTED'] }, notes: { type: 'string', minLength: 1, maxLength: 2000 }, amount: { type: 'integer', minimum: 0, description: 'Wajib untuk ADJUSTED; tidak melebihi denda awal' } } }),
        responses: { 200: jsonResponse('Keputusan tersimpan, refund dihitung ulang; kondisi fisik tetap'), 403: errorResponse('Bukan admin perusahaan/pusat'), 409: errorResponse('Keputusan final sudah tercatat') } }
    },
    '/api/rentals/{id}/fine-payments/simulate': {
      post: { ...authOperation({ tags: ['Inspection, Fine & Refund'], summary: 'Customer melunasi seluruh selisih denda setelah deposit; nominal dihitung server', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Pembayaran akademik idempotent; denda final tidak dapat disengketa ulang'), 403: errorResponse('Bukan customer pemilik'), 409: errorResponse('Masih sengketa atau tidak ada selisih') } }
    },
    '/api/reservations/{id}/handover': {
      post: {
        ...authOperation({ tags: ['Rental Operations'], summary: 'Handover dan inspeksi BEFORE', parameters: [idParameter] }),
        requestBody: jsonRequest(),
        responses: { 200: jsonResponse('Handover berhasil'), 403: errorResponse('Role tidak memiliki akses') }
      }
    },
    '/api/rentals': {
      get: {
        ...authOperation({ tags: ['Rental Operations'], summary: 'Daftar rental' }),
        responses: { 200: jsonResponse('Daftar rental') }
      }
    },
    '/api/rentals/{id}/return': {
      post: {
        ...authOperation({ tags: ['Inspection, Fine & Refund'], summary: 'Return dan inspeksi AFTER', parameters: [idParameter] }),
        requestBody: jsonRequest(),
        responses: { 200: jsonResponse('Return berhasil'), 409: errorResponse('Rental tidak aktif') }
      }
    },
    '/api/rentals/{id}/refund/confirm': {
      post: {
        ...authOperation({ tags: ['Inspection, Fine & Refund'], summary: 'Konfirmasi refund deposit', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Refund berhasil dikonfirmasi'), 403: errorResponse('Role tidak memiliki akses') }
      }
    },
    '/api/fines/{id}/disputes': {
      post: {
        ...authOperation({ tags: ['Inspection, Fine & Refund'], summary: 'Mengajukan keberatan denda', parameters: [idParameter] }),
        requestBody: jsonRequest(),
        responses: { 201: jsonResponse('Dispute dibuat') }
      }
    },
    '/api/tracking/vehicles': {
      get: {
        ...authOperation({ tags: ['GPS Tracking'], summary: 'Daftar kendaraan dengan rental aktif' }),
        responses: { 200: jsonResponse('Daftar tracking') }
      }
    },
    '/api/vehicles/{id}/locations': {
      get: {
        ...authOperation({ tags: ['GPS Tracking'], summary: 'Histori lokasi kendaraan', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Histori lokasi') }
      }
    },
    '/api/tracking/location': {
      post: {
        tags: ['GPS Tracking'],
        summary: 'Menerima telemetry dari GPS simulator',
        parameters: [
          {
            name: 'x-gps-token',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'Wajib; token server minimal 32 karakter. Tanpa konfigurasi endpoint 503.'
          }
        ],
        requestBody: jsonRequest({ $ref: '#/components/schemas/LocationRequest' }),
        responses: { 201: jsonResponse('Lokasi tersimpan'), 409: errorResponse('GPS atau rental belum siap') }
      }
    },
    '/api/admin/summary': {
      get: {
        ...authOperation({ tags: ['Admin'], summary: 'Ringkasan operasional admin' }),
        responses: { 200: jsonResponse('Ringkasan tersedia'), 403: errorResponse('Role tidak memiliki akses') }
      }
    },
    '/api/admin/customers': {
      get: {
        ...authOperation({ tags: ['Admin'], summary: 'Daftar customer untuk verifikasi' }),
        responses: { 200: jsonResponse('Daftar customer') }
      }
    },
    '/api/admin/customers/{id}/verification': {
      patch: {
        ...authOperation({ tags: ['Admin'], summary: 'Memperbarui status verifikasi customer', parameters: [idParameter] }),
        requestBody: jsonRequest({ $ref: '#/components/schemas/VerificationRequest' }),
        responses: { 200: jsonResponse('Status verifikasi diperbarui'), 403: errorResponse('Role tidak memiliki akses') }
      }
    },
    '/api/admin/companies': {
      get: {
        ...authOperation({ tags: ['Admin'], summary: 'Daftar seluruh perusahaan rental untuk Admin Pusat' }),
        responses: { 200: jsonResponse('Daftar perusahaan rental'), 403: errorResponse('Hanya Admin Pusat') }
      },
      post: {
        ...authOperation({ tags: ['Admin'], summary: 'Membuat perusahaan rental baru' }),
        requestBody: jsonRequest({
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            legalName: { type: 'string' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string' },
            description: { type: 'string' },
            deliveryRadiusKm: { type: 'number', maximum: 15 }
          }
        }),
        responses: { 201: jsonResponse('Perusahaan rental dibuat'), 403: errorResponse('Hanya Admin Pusat') }
      }
    },
    '/api/admin/companies/{id}': {
      patch: {
        ...authOperation({ tags: ['Admin'], summary: 'Mengubah status perusahaan rental', parameters: [idParameter] }),
        requestBody: jsonRequest({
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] } }
        }),
        responses: { 200: jsonResponse('Status perusahaan diperbarui'), 403: errorResponse('Hanya Admin Pusat') }
      }
    },
    '/api/admin/companies/{id}/admin-invite': {
      post: {
        ...authOperation({ tags: ['Admin'], summary: 'Mengundang Admin Rental ke perusahaan', parameters: [idParameter] }),
        requestBody: jsonRequest({
          type: 'object',
          required: ['email'],
          properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } }
        }),
        responses: { 201: jsonResponse('Undangan Admin Rental dibuat'), 403: errorResponse('Hanya Admin Pusat') }
      }
    },
    '/api/admin/fleet': {
      get: {
        ...authOperation({ tags: ['Admin'], summary: 'Daftar armada dan status GPS' }),
        responses: { 200: jsonResponse('Daftar armada') }
      }
    },
    '/api/admin/gps/diagnostics': {
      get: {
        ...authOperation({ tags: ['Admin'], summary: 'Diagnostik mapping GPS dan kendaraan' }),
        responses: { 200: jsonResponse('Diagnostik GPS tersedia'), 403: errorResponse('Role tidak memiliki akses') }
      }
    },
    '/api/admin/gps-agreements': {
      get: {
        ...authOperation({ tags: ['Admin'], summary: 'Daftar MoU GPS perusahaan rental' }),
        responses: { 200: jsonResponse('Daftar agreement GPS'), 403: errorResponse('Hanya Admin Pusat') }
      }
    },
    '/api/admin/companies/{id}/agreements': {
      post: {
        ...authOperation({ tags: ['Admin'], summary: 'Mengirim permintaan MoU kepada pemilik rental', parameters: [idParameter] }),
        requestBody: jsonRequest({ type: 'object', additionalProperties: false, properties: { notes: { type: 'string', maxLength: 2000 } }, description: 'Mengirim permintaan PENDING ke menu MoU pemilik perusahaan. Nomor otomatis; dokumen/tanggal final dilengkapi pemilik.' }),
        responses: { 201: jsonResponse('Permintaan MoU dikirim'), 403: errorResponse('Hanya Admin Pusat') }
      }
    },
    '/api/admin/gps-agreements/{id}': {
      patch: {
        ...authOperation({ tags: ['Admin'], summary: 'Mengubah status MoU GPS', parameters: [idParameter] }),
        requestBody: jsonRequest({
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED'] },
            gpsTrackingAllowed: { type: 'boolean' }
          }
        }),
        responses: { 200: jsonResponse('Agreement diperbarui'), 403: errorResponse('Hanya Admin Pusat') }
      }
    },
    '/api/maintenance': {
      get: {
        ...authOperation({ tags: ['Maintenance'], summary: 'Daftar maintenance kendaraan' }),
        responses: { 200: jsonResponse('Daftar maintenance') }
      },
      post: {
        ...authOperation({ tags: ['Maintenance'], summary: 'Membuat jadwal maintenance' }),
        requestBody: jsonRequest({ $ref: '#/components/schemas/MaintenanceRequest' }),
        responses: { 201: jsonResponse('Maintenance dibuat'), 403: errorResponse('Role tidak memiliki akses') }
      }
    },
    '/api/maintenance/{id}/start': {
      post: {
        ...authOperation({ tags: ['Maintenance'], summary: 'Memulai maintenance', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Maintenance dimulai'), 409: errorResponse('Status maintenance tidak valid') }
      }
    },
    '/api/maintenance/{id}/complete': {
      post: {
        ...authOperation({ tags: ['Maintenance'], summary: 'Menyelesaikan maintenance', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Maintenance selesai'), 409: errorResponse('Status maintenance tidak valid') }
      }
    },
    '/api/mou/online-terms': {
      get: { ...authOperation({ tags: ['MoU'], summary: 'Ketentuan popup simulasi akademik dan hash versi' }), responses: { 200: jsonResponse('Versi, hash, clauses dan checks'), 403: errorResponse('Role tidak diizinkan') } }
    },
    '/api/rental/gps-agreements/{id}/online-simulation': {
      post: { ...authOperation({ tags: ['MoU'], summary: 'Catat persetujuan dan buat PDF simulasi akademik', parameters: [idParameter] }), requestBody: jsonRequest({ type: 'object', required: ['termsVersion', 'termsHash', 'consents', 'includeSimulatedMeterai', 'expiresAt'], properties: { termsVersion: { type: 'string' }, termsHash: { type: 'string' }, consents: { type: 'object', required: ['terms', 'authority', 'privacy', 'simulation'], properties: Object.fromEntries(['terms', 'authority', 'privacy', 'simulation'].map((key) => [key, { type: 'boolean', enum: [true] }])) }, includeSimulatedMeterai: { type: 'boolean', enum: [true] }, expiresAt: { type: 'string', format: 'date' } } }), responses: { 201: jsonResponse('Receipt simulasi tersimpan, dokumen resmi tidak berubah'), 400: errorResponse('Persetujuan tidak lengkap'), 403: errorResponse('Bukan pemilik perusahaan'), 409: errorResponse('Versi stale, status tidak sesuai, atau simulasi sudah dibuat'), 503: errorResponse('Migration 012 diperlukan') } }
    },
    '/api/gps-agreements/{id}/online-simulation/document': {
      get: { ...authOperation({ tags: ['MoU'], summary: 'Download PDF simulasi privat', parameters: [idParameter] }), responses: { 200: { description: 'PDF simulasi akademik', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 403: errorResponse('Akses tidak diizinkan'), 404: errorResponse('Simulasi belum dibuat') } }
    },
    '/api/rental/gps-agreements': {
      get: { ...authOperation({ tags: ['MoU'], summary: 'MoU milik perusahaan Admin Rental' }), responses: { 200: jsonResponse('Daftar MoU'), 403: errorResponse('Role tidak diizinkan') } }
    },
    '/api/rental/gps-agreements/{id}/document': {
      post: { ...authOperation({ tags: ['MoU'], summary: 'Upload PDF final oleh pemilik rental', parameters: [idParameter] }), requestBody: jsonRequest({ type: 'object', required: ['documentDataUrl', 'stampType', 'signedAt', 'expiresAt', 'bothPartiesSigned'], properties: { documentDataUrl: { type: 'string', description: 'data:application/pdf;base64,... maksimal 8 MB; PDF final tidak diubah' }, stampType: { type: 'string', enum: ['PHYSICAL', 'E_METERAI'] }, signedAt: { type: 'string', format: 'date' }, expiresAt: { type: 'string', format: 'date' }, bothPartiesSigned: { type: 'boolean', enum: [true] } } }), responses: { 200: jsonResponse('PENDING untuk review'), 400: errorResponse('Dokumen/tanggal invalid'), 403: errorResponse('Perusahaan tidak diizinkan'), 409: errorResponse('Dokumen aktif tidak dapat diganti'), 503: errorResponse('Migration 011 diperlukan') } }
    },
    '/api/gps-agreements/{id}/document': {
      get: { ...authOperation({ tags: ['MoU'], summary: 'Download PDF final privat', parameters: [idParameter] }), responses: { 200: { description: 'Byte PDF asli', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 403: errorResponse('Akses tidak diizinkan'), 404: errorResponse('Dokumen belum ada') } }
    },
    '/api/mou/templates/{name}': {
      get: { ...authOperation({ tags: ['MoU'], summary: 'Download template fisik/digital DOCX/PDF', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string', enum: ['mou-transrent-fisik.docx', 'mou-transrent-digital.docx', 'mou-transrent-fisik.pdf', 'mou-transrent-digital.pdf'] } }] }), responses: { 200: { description: 'Template dokumen' }, 404: errorResponse('Template tidak ditemukan') } }
    },
    '/api/maintenance/{id}/cancel': {
      post: {
        ...authOperation({ tags: ['Maintenance'], summary: 'Membatalkan maintenance', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Maintenance dibatalkan'), 409: errorResponse('Status maintenance tidak valid') }
      }
    }
  }
});
