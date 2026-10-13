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
            required: false,
            schema: { type: 'string' },
            description: 'Wajib jika GPS_INGEST_TOKEN diaktifkan di backend.'
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
        ...authOperation({ tags: ['Admin'], summary: 'Membuat MoU GPS perusahaan rental', parameters: [idParameter] }),
        requestBody: jsonRequest({
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED'] },
            signedAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' },
            documentDataUrl: { type: 'string' },
            notes: { type: 'string' }
          },
          description: 'agreementNumber dibuat otomatis oleh backend dengan format MOU-GPS-YYYY-NNNNNN.'
        }),
        responses: { 201: jsonResponse('Agreement GPS dibuat'), 403: errorResponse('Hanya Admin Pusat') }
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
    '/api/maintenance/{id}/cancel': {
      post: {
        ...authOperation({ tags: ['Maintenance'], summary: 'Membatalkan maintenance', parameters: [idParameter] }),
        responses: { 200: jsonResponse('Maintenance dibatalkan'), 409: errorResponse('Status maintenance tidak valid') }
      }
    }
  }
});
