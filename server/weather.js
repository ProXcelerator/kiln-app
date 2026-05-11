// weather.js — Open-Meteo free weather API (no API key required)
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { latitude: 36.1627, longitude: -86.7816 };
  }
}

// Fetch the daily min/max for the current day
async function getDailyForecast() {
  const settings = loadSettings();
  let lat = settings.latitude || 36.1627;
  let lon = settings.longitude || -86.7816;

  if (settings.locationQuery && settings.locationQuery !== settings.lastLocationQuerySearched) {
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(settings.locationQuery)}&count=1&format=json`;
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) });
      const geoData = await geoRes.json();
      if (geoData.results && geoData.results.length > 0) {
        lat = geoData.results[0].latitude;
        lon = geoData.results[0].longitude;
        settings.latitude = lat;
        settings.longitude = lon;
        settings.lastLocationQuerySearched = settings.locationQuery;
        settings.locationName = `${geoData.results[0].name}${geoData.results[0].admin1 ? ', ' + geoData.results[0].admin1 : ''}`;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      }
    } catch (err) {
      console.warn('[Weather] Geocode failed:', err.message);
    }
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.daily && data.daily.temperature_2m_max && data.daily.temperature_2m_min) {
      const maxF = data.daily.temperature_2m_max[0];
      const minF = data.daily.temperature_2m_min[0];
      console.log(`[Weather] Daily Forecast - Max: ${maxF}°F, Min: ${minF}°F`);
      return { maxTempF: maxF, minTempF: minF };
    }
  } catch (err) {
    console.warn('[Weather] Fetch failed:', err.message);
  }
  return { maxTempF: null, minTempF: null };
}

module.exports = { getDailyForecast };
