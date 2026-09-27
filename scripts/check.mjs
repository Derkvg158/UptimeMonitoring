// Uptime checker — draait in GitHub Actions, schrijft resultaten naar docs/
// Geen npm-dependencies: alles met ingebouwde Node-modules.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import tls from "node:tls";

const ROOT = new URL("..", import.meta.url).pathname;
const MONITORS = `${ROOT}monitors.json`;
const STATUS = `${ROOT}docs/status.json`;
const HISTORY_DIR = `${ROOT}docs/history`;
const ALERT_FILE = `${ROOT}alert.txt`;

const DEFAULT_TIMEOUT = 15000;
const SLOW_MS = 3000;        // boven deze responstijd: "traag", geen storing
const CERT_WARN_DAYS = 14;   // waarschuwen als SSL-certificaat hierbinnen verloopt
const RECENT_KEEP = 288;     // ruwe metingen die we bewaren (~24u bij 5 min)
const DAILY_KEEP = 90;       // dagtotalen die we bewaren
const INCIDENTS_KEEP = 50;   // afgesloten en lopende storingen die we bewaren
const CONFIRM_ROUNDS = 2;    // pas melden als een site zoveel rondes achter elkaar faalt
const RETRY_DELAYS = [8000, 20000]; // wachttijd vóór de 2e en 3e poging binnen één ronde

const readJson = async (path, fallback) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

// Eerst naar een tijdelijk bestand, dan hernoemen: breekt het script halverwege
// af, dan blijft het oude bestand heel in plaats van leeg.
const writeAtomic = async (path, data) => {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
};

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const today = () => new Date().toISOString().slice(0, 10);

// Technische foutcodes omzetten naar iets wat je zonder opzoeken begrijpt.
const ERROR_TEXT = {
  ENOTFOUND: "domein niet gevonden (DNS)",
  EAI_AGAIN: "DNS reageert niet",
  ECONNREFUSED: "server weigert de verbinding",
  ECONNRESET: "verbinding verbroken door de server",
  ETIMEDOUT: "verbinding verloopt",
  EHOSTUNREACH: "server onbereikbaar",
  ENETUNREACH: "netwerk onbereikbaar",
  UND_ERR_CONNECT_TIMEOUT: "verbinding maken duurt te lang",
  UND_ERR_SOCKET: "verbinding onverwacht gesloten",
  CERT_HAS_EXPIRED: "SSL-certificaat verlopen",
  DEPTH_ZERO_SELF_SIGNED_CERT: "SSL-certificaat ongeldig (zelf ondertekend)",
  SELF_SIGNED_CERT_IN_CHAIN: "SSL-certificaat ongeldig (zelf ondertekend)",
  ERR_TLS_CERT_ALTNAME_INVALID: "SSL-certificaat hoort bij een ander domein",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "SSL-certificaatketen onvolledig",
};

const explain = (code) => (ERROR_TEXT[code] ? `${ERROR_TEXT[code]} (${code})` : code);

// --- één site checken -------------------------------------------------------

async function probe(monitor) {
  const timeout = monitor.timeoutMs ?? DEFAULT_TIMEOUT;
  const started = Date.now();
  try {
    const res = await fetch(monitor.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": "uptime-monitor (github actions)",
        "Accept": "text/html,*/*",
        "Cache-Control": "no-cache",
      },
    });
    const ms = Date.now() - started;
    const code = res.status;

    const min = monitor.expectStatus?.[0] ?? 200;
    const max = monitor.expectStatus?.[1] ?? 399;
    if (code < min || code > max) {
      return { ok: false, code, ms, reason: `HTTP ${code}` };
    }

    // Inhoud controleren: een site kan 200 teruggeven en tóch stuk zijn.
    if (monitor.mustContain || monitor.mustNotContain) {
      const body = await res.text();
      if (monitor.mustContain && !body.includes(monitor.mustContain)) {
        return { ok: false, code, ms, reason: `tekst "${monitor.mustContain}" niet gevonden` };
      }
      const banned = monitor.mustNotContain ?? [];
      for (const needle of [].concat(banned)) {
        if (body.includes(needle)) {
          return { ok: false, code, ms, reason: `foutmelding gevonden: "${needle}"` };
        }
      }
    }
    return { ok: true, code, ms, reason: null };
  } catch (err) {
    const ms = Date.now() - started;
    const name = err?.name === "TimeoutError"
      ? `geen antwoord binnen ${timeout / 1000}s`
      : explain(err?.cause?.code || err?.message || "netwerkfout");
    return { ok: false, code: 0, ms, reason: String(name) };
  }
}

// Een paar keer opnieuw proberen voordat we een ronde als mislukt tellen —
// scheelt loze meldingen bij een hikje in het netwerk of een herstartende server.
async function check(monitor) {
  let result = await probe(monitor);
  for (const delay of RETRY_DELAYS) {
    if (result.ok) return result;
    await new Promise((r) => setTimeout(r, delay));
    const next = await probe(monitor);
    result = next.ok ? { ...next, flaky: true } : next;
  }
  return result;
}

// --- SSL-certificaat ---------------------------------------------------------

function certificateInfo(url) {
  return new Promise((resolve) => {
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return resolve(null);
      host = u.hostname;
    } catch {
      return resolve(null);
    }
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: 10000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert?.valid_to) return resolve(null);
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.floor((validTo - Date.now()) / 86400000);
        resolve({ validTo: validTo.toISOString().slice(0, 10), daysLeft, issuer: cert.issuer?.O ?? null });
      }
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

// --- geschiedenis ------------------------------------------------------------

function updateHistory(history, result, now) {
  const point = { t: now, ok: result.ok ? 1 : 0, ms: result.ms, code: result.code };
  if (!result.ok) point.r = result.reason;
  const recent = [...(history.recent ?? []), point];
  const daily = { ...(history.daily ?? {}) };
  const day = today();
  const entry = daily[day] ?? { up: 0, total: 0, msSum: 0 };
  entry.total += 1;
  if (result.ok) { entry.up += 1; entry.msSum += result.ms; }
  daily[day] = entry;

  const days = Object.keys(daily).sort();
  for (const d of days.slice(0, Math.max(0, days.length - DAILY_KEEP))) delete daily[d];

  return { recent: recent.slice(-RECENT_KEEP), daily, incidents: history.incidents ?? [] };
}

// Storingslog: één regel per bevestigde storing, met begin, einde en oorzaak.
function openIncident(history, start, reason) {
  if (history.incidents.some((i) => i.end === null)) return;
  history.incidents = [...history.incidents, { start, end: null, reason }].slice(-INCIDENTS_KEEP);
}

function closeIncident(history, end) {
  const open = history.incidents.findLast((i) => i.end === null);
  if (open) open.end = end;
}

// Uptime over de laatste 24 uur rekenen we uit de losse metingen; de dagtotalen
// zouden hier ook gisteren (en dus tot 48 uur) meetellen.
function uptimeRecent(recent, hours) {
  const cutoff = Date.now() - hours * 3600000;
  const points = recent.filter((p) => Date.parse(p.t) >= cutoff);
  if (!points.length) return null;
  return Math.round((points.filter((p) => p.ok).length / points.length) * 10000) / 100;
}

function uptimePct(daily, days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let up = 0, total = 0;
  for (const [d, v] of Object.entries(daily)) {
    if (d >= cutoff) { up += v.up; total += v.total; }
  }
  return total ? Math.round((up / total) * 10000) / 100 : null;
}

// --- meldingen ---------------------------------------------------------------

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error("Telegram mislukt:", err.message);
  }
}

// --- hoofdprogramma ----------------------------------------------------------

const config = await readJson(MONITORS, { monitors: [] });
const previous = await readJson(STATUS, { monitors: [] });
const prevBySlug = Object.fromEntries((previous.monitors ?? []).map((m) => [m.slug, m]));
await mkdir(HISTORY_DIR, { recursive: true });

const now = new Date().toISOString();
const events = [];
const monitors = [];

for (const monitor of config.monitors) {
  const slug = monitor.slug ?? slugify(monitor.name ?? monitor.url);
  const prev = prevBySlug[slug] ?? {};

  // Onderhoud: site overslaan, geen metingen en geen meldingen.
  if (monitor.paused) {
    monitors.push({ ...prev, slug, name: monitor.name, url: monitor.url, paused: true });
    console.log(`PAUZE ${monitor.name}`);
    continue;
  }

  const result = await check(monitor);

  const cert = result.ok ? await certificateInfo(monitor.url) : (prev.cert ?? null);

  const historyPath = `${HISTORY_DIR}/${slug}.json`;
  const history = updateHistory(await readJson(historyPath, {}), result, now);

  const changed = prev.ok !== result.ok;
  const since = changed || prev.since === undefined ? now : prev.since;

  // Pas een storing melden als hij meerdere rondes achter elkaar aanhoudt.
  // "Weer bereikbaar" alleen als er eerder ook echt een storing gemeld is.
  const confirmRounds = monitor.confirmRounds ?? config.confirmRounds ?? CONFIRM_ROUNDS;
  const failCount = result.ok ? 0 : (prev.failCount ?? 0) + 1;
  // Oudere status.json kent `alerted` nog niet: een site die toen al plat lag,
  // is toen ook al gemeld.
  let alerted = result.ok ? false : (prev.alerted ?? prev.ok === false);

  if (!result.ok && !alerted && failCount >= confirmRounds) {
    alerted = true;
    openIncident(history, since, result.reason);
    events.push({ level: "down", name: monitor.name, url: monitor.url, text: `${monitor.name} is onbereikbaar — ${result.reason}` });
  }
  if (result.ok && (prev.alerted ?? prev.ok === false)) {
    closeIncident(history, now);
    const minutes = prev.since ? Math.round((Date.parse(now) - Date.parse(prev.since)) / 60000) : null;
    events.push({ level: "up", name: monitor.name, url: monitor.url, text: `${monitor.name} is weer bereikbaar${minutes !== null ? ` (${minutes} min offline)` : ""}` });
  }
  await writeAtomic(historyPath, JSON.stringify(history));

  // Certificaatwaarschuwing: hooguit één keer per dag per site.
  let certAlertedOn = prev.certAlertedOn ?? null;
  if (cert && cert.daysLeft <= CERT_WARN_DAYS && certAlertedOn !== today()) {
    events.push({ level: "cert", name: monitor.name, url: monitor.url, text: `SSL-certificaat van ${monitor.name} verloopt over ${cert.daysLeft} dagen (${cert.validTo})` });
    certAlertedOn = today();
  }

  monitors.push({
    slug,
    name: monitor.name,
    url: monitor.url,
    ok: result.ok,
    code: result.code,
    ms: result.ms,
    slow: result.ok && result.ms > (monitor.slowMs ?? SLOW_MS),
    reason: result.reason,
    flaky: result.flaky ?? false,
    since,
    failCount,
    alerted,
    checkedAt: now,
    cert,
    certAlertedOn,
    uptime: { d1: uptimeRecent(history.recent, 24), d7: uptimePct(history.daily, 7), d30: uptimePct(history.daily, 30) },
  });

  console.log(`${result.ok ? "OK  " : "DOWN"} ${monitor.name} — ${result.code || "-"} in ${result.ms}ms${result.reason ? ` (${result.reason})` : ""}`);
}

const down = monitors.filter((m) => !m.ok && !m.paused);
await writeAtomic(STATUS, JSON.stringify({ title: config.title ?? null, generated: now, monitors }, null, 2));

if (events.length) {
  const icon = { down: "🔴", up: "🟢", cert: "🟠" };
  await telegram(events.map((e) => `${icon[e.level]} <b>${e.text}</b>\n${e.url}`).join("\n\n"));

  const subject = events.some((e) => e.level === "down")
    ? `Storing: ${events.filter((e) => e.level === "down").map((e) => e.name).join(", ")}`
    : events[0].text;
  const body = events.map((e) => `${e.text}\n${e.url}`).join("\n\n") + `\n\nGecontroleerd om ${new Date(now).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}`;
  await writeFile(ALERT_FILE, `${subject}\n---\n${body}`);
}

console.log(down.length ? `\n${down.length} site(s) offline.` : "\nAlles draait.");
