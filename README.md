# WAFEO Digital Twin

Water, Agriculture & Food systems Earth Observation platform.
Live: **https://wafeo-webapplication.vercel.app**

The home page opens first on every visit. Anyone with a Google account can sign in;
first-time users get an account automatically (role `researcher`). **Try the demo**
(next to Sign in / Sign up) opens the whole platform with no account: a 12-hour
session where nothing is saved. Admins manage roles on the **Users** page.

---

## Project layout

```
index.html, style.css, app.js   Frontend (single-page app, no build step)
landing.css, landing.js         Home page: pinned scroll hero, sections, hand-off to sign-in
eo.js                           Site Intelligence analysis UI (click a field, point + radius, or draw)
atlas.js                        Dashboard world map: rotating globe / flat map, 208-country atlas with flags,
                                country cards (World Bank statistics, hazards), click-to-select a field
livenews.js                     Live News panel (Reports): auto-refresh, date archive, region and topic filters
report.js                       PDF report "Analysis_Report_WAFEO_<area>.pdf" (jsPDF)
pages.js                        Live Dashboard and domain pages (plain + expert views, charts, maps)
assets/                         Logo, images and countries.json (the 208 countries and territories)
data/users.json                 Local user store (development only; production uses Firestore)
server.js                       Local entry point: `npm start`
api/index.js                    Vercel serverless entry (same app)
server/
  app.js                        Express app: middleware, routing, static files
  config.js                     All environment settings in one place
  store.js                      Data layer: Firestore if configured, else data/*.json
  auth.js                       Password hashing, JWT, auth/role middleware, rate limit
  routes/auth.js                /api/auth/*  login, google, register, demo, me, logout
  routes/data.js                /api/news (live and by date)
  routes/platform.js            AI assistant, reports, activity log, admin
  routes/eo.js                  /api/eo/analyze, /api/eo/field, /api/eo/ndvi-series, /api/live/hazards
  services/news.js              Verified live news: trusted outlet feeds, Google News and GDELT search, 3-min refresh
  services/eo/                  Satellite analysis engine:
    sentinel2.js                  Sentinel-2 L2A: NDVI/EVI/SAVI, red-edge N, NDMI, BSI, water, NDTI, NDCI, 24-month NDVI
    planetary.js                  Landsat 8/9 LST, Copernicus DEM, ESA WorldCover, JRC Global Surface Water
    soil.js                       ISRIC SoilGrids (WCS): texture, pH, SOC, N, CEC, bulk density, WRB type, AWC
    climate.js                    Open-Meteo: weather, ET0, soil moisture, ERA5 rainfall anomaly, GloFAS rivers
    analyze.js                    Fuses sources into scores, ranked issues, and actions for farmers/government/public
lib/firebase.js                 Firebase Admin initialisation
firebase-seed.js                One-off: copy data/*.json into Firestore (`npm run seed`)
tests/api.test.js               API tests (`npm test`)
```

## Run locally

```bash
npm install
cp .env.example .env      # optional locally; see below
npm run dev               # http://localhost:8080, restarts on file changes
npm test                  # API test suite (never touches data/)
```

Without a `.env` the server uses the JSON files in `data/` and a random session
secret (you'll be signed out when the server restarts).

Demo accounts (password `wafeo2024`): `admin`, `farmer`, `policy`, `researcher`.

## Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `JWT_SECRET` | **Production** | Signs session tokens. Any long random string. Without it (and without Firebase), the production API refuses to run. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Production | Firestore storage for users, reports and activity. Without them, new accounts are not saved on Vercel. |
| `GOOGLE_CLIENT_ID` | Optional | OAuth client ID(s), comma-separated. Defaults to the WAFEO client. |
| `ADMIN_EMAILS` | Optional | Comma-separated Google emails that are made admin whenever they sign in with Google. |
| `DEFAULT_ROLE` | Optional | Role for new sign-ups (default `researcher`). |
| `EARTHDATA_TOKEN` | Optional | NASA Earthdata token (urs.earthdata.nasa.gov → Generate Token). Enables ECOSTRESS, SMAP, GRACE-FO and SWOT. |
| `ISDA_USERNAME`, `ISDA_PASSWORD` | Optional | iSDAsoil API account. Enables 30 m soil nutrients. |
| `GROQ_API_KEY`, `GROQ_MODEL` | Optional | Enables the AI assistant (free key at console.groq.com). |
| `CORS_ORIGINS` | Optional | Extra origins allowed to call the API. |
| `JWT_EXPIRES_IN` | Optional | Session length (default `7d`). |

Set these on Vercel under **Project → Settings → Environment Variables**, then redeploy.

## Google sign-in for everyone

The button works with the OAuth client in `GOOGLE_CLIENT_ID`. For *any* Google
account (not just test users) to sign in, in [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. **APIs & Services → OAuth consent screen**: set *User type* to **External**
   and click **Publish app** so the status is **In production**. While it is
   "Testing", only listed test users can sign in. The app only asks for the
   basic `openid email profile` scopes, so Google does not require verification.
2. **Credentials → your Web client → Authorized JavaScript origins** must include:
   `https://wafeo-webapplication.vercel.app`, `http://localhost:8080`, and
   `https://norbertmuzila.github.io` if you still use GitHub Pages.

## API

All endpoints except health and auth require `Authorization: Bearer <token>`.

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | Status, storage backend, AI configured |
| POST | `/api/auth/login` | `{ username, password }` (username or email) |
| POST | `/api/auth/google` | `{ credential }` Google ID token |
| POST | `/api/auth/register` | `{ name, email, username, password, region }` |
| POST | `/api/auth/demo` | No-account demo session (12 h; cannot save or administer; limited per IP) |
| GET | `/api/auth/me` | Restore session, returns a fresh token |
| POST | `/api/eo/analyze` | Live satellite, soil, weather, FEWS NET and GDACS analysis of `{ point, radius_m }` or `{ geometry }` |
| GET | `/api/eo/field?lon=&lat=` | Traces the field under a map click from the latest clear Sentinel-2 image (10 m): returns its outline polygon and area |
| POST | `/api/eo/ndvi-series` | 24 months of Sentinel-2 NDVI for the same area |
| GET | `/api/live/hazards` | Live GDACS hazard alerts (drought, flood, cyclone, volcano, wildfire) |
| GET | `/api/news` · `/api/news?date=YYYY-MM-DD` | Verified news on water, agriculture, food security and climate hazards: live (refreshed every 3 minutes) or for any date since 2015 |
| POST | `/api/ai/chat` | `{ messages: [{ role, content }] }` |
| GET/POST | `/api/reports` | Saved reports (per user) |
| GET | `/api/admin/users`, `/api/admin/activity` | Admin only |
| POST | `/api/admin/users/:id/role` | Admin only, `{ role }` |

## Live satellite analysis

On the **Dashboard** map, zoom in until fields are visible and click inside one: its outline is traced from the newest clear Sentinel-2 image and you can analyse it straight away. **Site Intelligence** offers the same "Click a field" mode, plus point + radius and drawing a boundary. The server reads only the pixels inside the area (HTTP range requests on cloud-optimised GeoTIFFs), so a farm costs kilobytes and takes ~5–20 seconds.

| Source | What it gives | Access |
|---|---|---|
| Sentinel-2 L2A (ESA) | Crop vigour, nitrogen, canopy water, bare soil, open water, turbidity, chlorophyll-a; 24-month NDVI | Microsoft Planetary Computer, keyless |
| Landsat 8/9 (USGS/NASA) | Land surface temperature (heat stress) | Planetary Computer, keyless |
| Copernicus DEM GLO-30 | Elevation, slope, erosion risk | Planetary Computer, keyless |
| ESA WorldCover | Land-cover composition | Planetary Computer, keyless |
| JRC Global Surface Water | Historical water extent (1984–2021) | Planetary Computer, keyless |
| ISRIC SoilGrids 2.0 | Soil type, texture, pH, carbon, nitrogen, CEC, plant-available water | ISRIC WCS, keyless |
| Open-Meteo / ERA5 / GloFAS | Weather, 16-day forecast, ET₀, soil moisture, 25-year rainfall anomaly, river flow | Open-Meteo, keyless |
| ECOSTRESS (NASA JPL) | Evaporative stress index + daily ET at 70 m (crop water stress 1–2 weeks early) | LP DAAC COGs, needs `EARTHDATA_TOKEN` |
| SMAP L3 enhanced (NASA) | Satellite surface soil moisture, 9 km, latest + 7-day mean | NSIDC OPeNDAP (one grid cell), needs `EARTHDATA_TOKEN` |
| GRACE / GRACE-FO (NASA/GFZ) | Groundwater / total water storage anomaly, 5-year trend, percentile since 2002 | PO.DAAC OPeNDAP (one cell), needs `EARTHDATA_TOKEN` |
| SWOT (NASA/CNES) | Lake and reservoir water level and area, 30-day and 1-year change | PO.DAAC LakeSP + Hydrocron, needs `EARTHDATA_TOKEN`; only runs when the area holds water |
| iSDAsoil (iSDA Africa) | 30 m soil N, P, K, Zn, pH, carbon, texture | iSDA API, needs `ISDA_USERNAME` / `ISDA_PASSWORD` |
| NISAR (NASA/ISRO) | 200 m radar soil moisture | Not connected: provisional data is only offered as ~130 MB files with no per-area access |

Results appear on the Crop, Precision Farming, Soil, Water, Drought, Early Warning and Food Security pages. **Download PDF report** (on every page's site bar, Site Intelligence and Reports) creates `Analysis_Report_WAFEO_<area>.pdf`: A4, 12 pt justified text in Helvetica (the PDF standard font with Arial's metrics), the colour-analysed field (vegetation-health map and natural-colour image), every reading with its plain meaning, priority findings, two-year greenness chart, 16-day outlook, nearby hazards and actions for farmers, government and the public. It reports results only; data-source names are left out.

## Security notes

- Passwords are salted scrypt hashes. Older SHA-256 hashes are upgraded on the next login.
- Login, sign-up and AI endpoints are rate-limited.
- Only `index.html`, `app.js`, `style.css`, `assets/` and the public datasets are served; server code, `.env` and `users.json` are not.
