const apiUrl = process.env.TRANSRENT_API_URL || 'http://localhost:4100/api';
const deviceId = process.env.GPS_DEVICE_ID || 'GPS-AVANZA-01';
const gpsToken = process.env.GPS_INGEST_TOKEN || '';
const intervalMs = Number(process.env.GPS_INTERVAL_MS || 10_000);

if (gpsToken.length < 32) throw new Error('Isi GPS_INGEST_TOKEN minimal 32 karakter, sama dengan backend.');
if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('GPS_INTERVAL_MS minimal 1000 ms.');

const routes = {
  'GPS-AVANZA-01': { latitude: -8.7179, longitude: 115.1682 },
  'GPS-VARIO-01': { latitude: -8.7186, longitude: 115.1694 },
  'GPS-INNOVA-01': { latitude: -8.6884, longitude: 115.2631 },
  'GPS-NMAX-01': { latitude: -8.6913, longitude: 115.1681 }
};

const point = routes[deviceId] || { latitude: -8.7179, longitude: 115.1682 };
let tick = 0;

const sendLocation = async () => {
  tick += 1;
  const location = {
    deviceId,
    latitude: point.latitude + Math.sin(tick / 5) * 0.0012,
    longitude: point.longitude + Math.cos(tick / 5) * 0.0012,
    speed: 18 + Math.abs(Math.sin(tick / 3) * 12),
    heading: (tick * 24) % 360
  };
  try {
    const response = await fetch(`${apiUrl}/tracking/location`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gpsToken ? { 'x-gps-token': gpsToken } : {})
      },
      body: JSON.stringify(location)
    });
    const payload = await response.json();
    if (!response.ok) console.log(`[GPS ${deviceId}] ${payload.message}`);
    else console.log(`[GPS ${deviceId}] ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} at ${location.speed.toFixed(1)} km/h`);
  } catch (error) {
    console.error(`[GPS ${deviceId}] backend unavailable: ${error.message}`);
  }
};

console.log(`TransRent GPS simulator: ${deviceId} every ${intervalMs / 1000}s`);
sendLocation();
setInterval(sendLocation, intervalMs);
