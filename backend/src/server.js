import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import {
  confirmRefund,
  cancelMaintenance,
  completeMaintenance,
  createMaintenance,
  createGpsAgreement,
  createRentalCompany,
  createReservation,
  expirePendingReservations,
  getCompanies,
  getSummary,
  gpsDiagnostics,
  listGpsAgreements,
  handover,
  ingestLocation,
  listCustomers,
  listFleet,
  listLocations,
  listMaintenance,
  listRentalCompanies,
  listRentals,
  listReservations,
  returnRental,
  searchVehicles,
  simulatePayment,
  startMaintenance,
  submitDispute,
  trackingVehicles,
  updateRentalCompany,
  updateGpsAgreement,
  updateVerification,
  inviteRentalAdmin
} from './data/store.js';
import {
  authMode,
  login,
  loginDemo,
  persistenceMode,
  registerAccount,
  requireAuth,
  requireRoles
} from './auth.js';
import {
  authConfigured,
  databaseConfigured,
  getDatabaseHealth,
  persistence
} from './db.js';
import { createOpenapiSpec } from './openapi.js';
import { paymentProvider } from './payments.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4100);
const openapiSpec = createOpenapiSpec(
  process.env.PUBLIC_API_URL || `http://localhost:${port}`
);

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use(express.json({ limit: '12mb' }));

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: 'TransRent API Documentation'
  })
);

app.get('/api/openapi.json', (request, response) => {
  response.json(openapiSpec);
});

const asyncRoute = (handler) => async (request, response, next) => {
  try {
    await handler(request, response, next);
  } catch (error) {
    next(error);
  }
};

app.get('/api/health', (request, response) => response.json({
  ok: true,
  service: 'transrent-backend',
  persistence,
  persistenceMode,
  authMode,
  paymentProvider,
  databaseConfigured,
  authConfigured,
  deliveryRadiusKm: 15,
  timestamp: new Date().toISOString()
}));

app.get('/api/health/deep', asyncRoute(async (request, response) => {
  const database = await getDatabaseHealth();
  response.status(database.reachable || !database.configured ? 200 : 503).json({
    ok: database.reachable || !database.configured,
    service: 'transrent-backend',
    persistence,
    persistenceMode,
    authMode,
    paymentProvider,
    database,
    timestamp: new Date().toISOString()
  });
}));

app.post('/api/auth/demo-login', (request, response, next) => {
  try {
    response.json(loginDemo(request.body.email, request.body.password));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', asyncRoute(async (request, response) => {
  response.json(await login(
    request.body.email,
    request.body.password
  ));
}));

app.post('/api/auth/register', asyncRoute(async (request, response) => {
  const result = await registerAccount(request.body);
  response.status(201).json(result);
}));

app.get('/api/auth/me', requireAuth, (request, response) => response.json({ user: request.actor }));

app.get('/api/companies', asyncRoute(async (request, response) => response.json({ companies: await getCompanies() })));

app.get('/api/admin/companies', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ companies: await listRentalCompanies(request.actor) });
}));

app.post('/api/admin/companies', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.status(201).json({ company: await createRentalCompany(request.actor, request.body) });
}));

app.patch('/api/admin/companies/:id', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ company: await updateRentalCompany(request.actor, request.params.id, request.body) });
}));

app.post('/api/admin/companies/:id/admin-invite', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.status(201).json({ invitation: await inviteRentalAdmin(request.actor, request.params.id, request.body) });
}));

app.get('/api/branches/search', asyncRoute(async (request, response) => {
  const { latitude, longitude, startDate, endDate, type } = request.query;
  response.json({
    deliveryRadiusKm: 15,
    results: await searchVehicles({ latitude, longitude, startDate, endDate, type })
  });
}));

app.get('/api/reservations', requireAuth, asyncRoute(async (request, response) => {
  response.json({ reservations: await listReservations(request.actor) });
}));

app.post('/api/reservations', requireAuth, asyncRoute(async (request, response) => {
  response.status(201).json({
    reservation: await createReservation(request.actor, request.body)
  });
}));

app.post('/api/reservations/:id/payments/simulate', requireAuth, asyncRoute(async (request, response) => {
  response.json(
    await simulatePayment(request.actor, request.params.id)
  );
}));

app.post('/api/reservations/:id/handover', requireAuth, requireRoles('STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json(
    await handover(request.actor, request.params.id, request.body)
  );
}));

app.get('/api/rentals', requireAuth, asyncRoute(async (request, response) => {
  response.json({ rentals: await listRentals(request.actor) });
}));

app.post('/api/rentals/:id/return', requireAuth, requireRoles('STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json(
    await returnRental(request.actor, request.params.id, request.body)
  );
}));

app.post('/api/rentals/:id/refund/confirm', requireAuth, requireRoles('RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json(
    await confirmRefund(request.actor, request.params.id)
  );
}));

app.post('/api/fines/:id/disputes', requireAuth, requireRoles('CUSTOMER'), asyncRoute(async (request, response) => {
  response.status(201).json({
    dispute: await submitDispute(request.actor, request.params.id, request.body)
  });
}));

app.get('/api/tracking/vehicles', requireAuth, asyncRoute(async (request, response) => {
  response.json({ vehicles: await trackingVehicles(request.actor) });
}));

app.get('/api/vehicles/:id/locations', requireAuth, asyncRoute(async (request, response) => {
  response.json({
    locations: await listLocations(request.actor, request.params.id)
  });
}));

app.post('/api/tracking/location', asyncRoute(async (request, response) => {
  const expectedToken = process.env.GPS_INGEST_TOKEN;
  if (expectedToken && request.headers['x-gps-token'] !== expectedToken) {
    return response.status(401).json({
      message: 'GPS ingest token tidak valid.'
    });
  }
  response.status(201).json({
    location: await ingestLocation(request.body)
  });
}));

app.get('/api/admin/summary', requireAuth, requireRoles('RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ summary: await getSummary(request.actor) });
}));

app.get('/api/admin/customers', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ customers: await listCustomers(request.actor) });
}));

app.patch('/api/admin/customers/:id/verification', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({
    customer: await updateVerification(request.actor, request.params.id, request.body.status)
  });
}));

app.get('/api/maintenance', requireAuth, requireRoles('STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ maintenance: await listMaintenance(request.actor) });
}));

app.get('/api/admin/fleet', requireAuth, requireRoles('STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ fleet: await listFleet(request.actor) });
}));

app.get('/api/admin/gps/diagnostics', requireAuth, requireRoles('STAFF', 'RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json(await gpsDiagnostics(request.actor));
}));

app.get('/api/admin/gps-agreements', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ agreements: await listGpsAgreements(request.actor) });
}));

app.post('/api/admin/companies/:id/agreements', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.status(201).json({ agreement: await createGpsAgreement(request.actor, { ...request.body, companyId: request.params.id }) });
}));

app.patch('/api/admin/gps-agreements/:id', requireAuth, requireRoles('CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ agreement: await updateGpsAgreement(request.actor, request.params.id, request.body) });
}));

app.post('/api/maintenance', requireAuth, requireRoles('RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.status(201).json({
    maintenance: await createMaintenance(request.actor, request.body)
  });
}));

app.post('/api/maintenance/:id/start', requireAuth, requireRoles('RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ maintenance: await startMaintenance(request.actor, request.params.id) });
}));

app.post('/api/maintenance/:id/complete', requireAuth, requireRoles('RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ maintenance: await completeMaintenance(request.actor, request.params.id) });
}));

app.post('/api/maintenance/:id/cancel', requireAuth, requireRoles('RENTAL_ADMIN', 'CENTRAL_ADMIN'), asyncRoute(async (request, response) => {
  response.json({ maintenance: await cancelMaintenance(request.actor, request.params.id) });
}));

app.use((error, request, response, next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    message: error.message || 'Internal server error.',
    ...(error.code ? { code: error.code } : {})
  });
});

const runExpirySweep = () => {
  expirePendingReservations().catch((error) => {
    console.warn(`Reservation expiry sweep gagal: ${error.message}`);
  });
};

runExpirySweep();
const expiryTimer = setInterval(runExpirySweep, 60_000);
expiryTimer.unref?.();

app.listen(port, () => {
  console.log(`TransRent backend listening on http://localhost:${port}`);
  console.log(`Mode: ${persistenceMode}; demo credentials are documented in README.md`);
});
