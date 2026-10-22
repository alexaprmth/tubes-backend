// Regression tests always use synthetic in-memory data, even with a live .env.
for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_ANON_KEY']) process.env[name] = '';
process.env.PAYMENT_PROVIDER = 'SIMULATED_GATEWAY';
process.env.ALLOW_DEMO_AUTH = 'true';

process.env.PAYMENT_MODE = 'LEGACY_SIMULATION';
