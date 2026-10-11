const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const cors = require('cors');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { ensureCerts } = require('./scripts/gen-certs');
const { createHypeRateHub } = require('./lib/hyperate');
const { createWorkoutStore } = require('./lib/workouts');
const WocMetrics = require('./lib/metrics');

/** Carica `.env` locale senza dipendenza dotenv (non sovrascrive env già impostate). */
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT) || 3033;
const ROOM = process.env.ROOM || 'spinning';
const STALE_MS = 15000;
const USE_HTTPS = process.env.HTTPS !== 'false';

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.get('/metrics.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'lib', 'metrics.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

/** Storico allenamenti su data/workouts/ (JSON). Creato dopo io — vedi sotto. */
let workouts = null;
let io = null;

function broadcastWorkout() {
  if (!io || !workouts) return;
  io.emit('workout:status', workouts.status());
}

/** @type {Map<string, {
 *  id: string,
 *  name: string,
 *  room: string,
 *  bpm: number|null,
 *  lastSeen: number,
 *  source: string,
 *  deviceName: string|null,
 *  quality: string|null,
 *  profile: object|null,
 *  intensityPct: number|null,
 *  kcalSession: number,
 *  kcalPerMin: number|null,
 *  lastBpmAt: number|null
 * }>} */
const participants = new Map();

/** Ultimi eventi BPM (ring buffer per /api/stream e log) */
const recentEvents = [];
const MAX_EVENTS = 200;

function localIps() {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  // Preferisci Wi‑Fi / LAN tipiche; 172.* spesso è Hyper-V / WSL / Docker
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 3;
    return 2;
  };
  return ips.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function pruneStale() {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of participants) {
    if (now - p.lastSeen > STALE_MS) {
      participants.delete(id);
      hyperate.unsubscribe(id);
      changed = true;
    }
  }
  if (changed) broadcastRoster();
}

function rosterPayload() {
  return [...participants.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'it'))
    .map((p) => ({
      id: p.id,
      participantId: p.id,
      name: p.name,
      bpm: p.bpm,
      lastSeen: p.lastSeen,
      source: p.source,
      deviceName: p.deviceName,
      quality: p.quality,
      live: Date.now() - p.lastSeen < 5000,
      profile: p.profile || null,
      intensityPct: p.intensityPct,
      kcalSession: Math.round((p.kcalSession || 0) * 10) / 10,
      kcalPerMin: p.kcalPerMin != null ? Math.round(p.kcalPerMin * 10) / 10 : null,
      maxHr: p.profile ? WocMetrics.resolveMaxHr(p.profile) : WocMetrics.DEFAULT_MAX_HR,
      restingHr: p.profile ? WocMetrics.resolveRestHr(p.profile) : WocMetrics.DEFAULT_REST_HR
    }));
}

function broadcastRoster() {
  io.emit('lista-allievi', { room: ROOM, students: rosterPayload(), participants: rosterPayload() });
}

function upsertParticipant(id, name, room, profile) {
  const existing = participants.get(id);
  const nextProfile =
    profile != null
      ? WocMetrics.normalizeProfile(profile)
      : existing?.profile ?? null;
  const entry = {
    id,
    name: String(name || existing?.name || 'Partecipante').trim().slice(0, 40) || 'Partecipante',
    room: room || ROOM,
    bpm: existing?.bpm ?? null,
    lastSeen: Date.now(),
    source: existing?.source || 'ble',
    deviceName: existing?.deviceName ?? null,
    quality: existing?.quality ?? null,
    profile: nextProfile,
    intensityPct: existing?.intensityPct ?? null,
    kcalSession: existing?.kcalSession ?? 0,
    kcalPerMin: existing?.kcalPerMin ?? null,
    lastBpmAt: existing?.lastBpmAt ?? null
  };
  participants.set(id, entry);
  return entry;
}

function applyProfile(id, profile, name, room) {
  const participant = upsertParticipant(id, name, room, profile);
  if (participant.bpm != null) {
    participant.intensityPct = WocMetrics.intensityPct(participant.bpm, participant.profile);
    participant.kcalPerMin = WocMetrics.kcalPerMinute(participant.bpm, participant.profile);
  }
  broadcastRoster();
  return participant;
}

function pushEvent(evt) {
  recentEvents.push(evt);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

function recordBpm({
  participantId,
  name,
  bpm,
  t,
  source = 'ble',
  deviceName = null,
  quality = null,
  room = ROOM,
  profile = null,
  intensityPct: clientPct = null,
  kcalDelta = null
}) {
  const value = Math.round(Number(bpm));
  if (!Number.isFinite(value) || value <= 0 || value > 400) return false;

  const id = String(participantId || '').trim().slice(0, 64);
  if (!id) return false;

  const participant = upsertParticipant(id, name, room, profile);
  const now = Number(t) || Date.now();
  const prevAt = participant.lastBpmAt;

  participant.bpm = value;
  participant.lastSeen = now;
  participant.source = source || 'ble';
  participant.deviceName = deviceName ? String(deviceName).slice(0, 80) : participant.deviceName;
  participant.quality = quality != null ? String(quality).slice(0, 40) : participant.quality;

  const pct =
    clientPct != null && Number.isFinite(Number(clientPct))
      ? Math.min(100, Math.max(0, Math.round(Number(clientPct))))
      : WocMetrics.intensityPct(value, participant.profile);
  participant.intensityPct = pct;

  const kcalMin = WocMetrics.kcalPerMinute(value, participant.profile);
  participant.kcalPerMin = kcalMin;

  if (kcalDelta != null && Number.isFinite(Number(kcalDelta)) && Number(kcalDelta) > 0) {
    participant.kcalSession = (participant.kcalSession || 0) + Number(kcalDelta);
  } else if (kcalMin != null && prevAt && now > prevAt) {
    const dtMin = Math.min((now - prevAt) / 60000, 2);
    if (dtMin > 0) participant.kcalSession = (participant.kcalSession || 0) + kcalMin * dtMin;
  }
  participant.lastBpmAt = now;

  const evt = {
    participantId: participant.id,
    name: participant.name,
    bpm: value,
    t: participant.lastSeen,
    source: participant.source,
    deviceName: participant.deviceName,
    quality: participant.quality,
    intensityPct: participant.intensityPct,
    kcalSession: participant.kcalSession,
    kcalPerMin: participant.kcalPerMin
  };
  pushEvent(evt);

  console.log(
    `[BPM] ${participant.name} (${participant.id}): ${value}` +
      (participant.deviceName ? ` ← ${participant.deviceName}` : '') +
      ` [${participant.source}]` +
      (pct != null ? ` ${pct}%` : '') +
      (participant.kcalSession ? ` ~${Math.round(participant.kcalSession)} kcal` : '')
  );

  io.emit('battito-allievo', {
    id: participant.id,
    participantId: participant.id,
    name: participant.name,
    bpm: value,
    timestamp: participant.lastSeen,
    t: participant.lastSeen,
    source: participant.source,
    deviceName: participant.deviceName,
    quality: participant.quality,
    intensityPct: participant.intensityPct,
    kcalSession: Math.round((participant.kcalSession || 0) * 10) / 10,
    kcalPerMin: participant.kcalPerMin != null ? Math.round(participant.kcalPerMin * 10) / 10 : null
  });
  broadcastRoster();

  if (workouts) {
    workouts.recordSample({
      participantId: participant.id,
      name: participant.name,
      bpm: value,
      t: participant.lastSeen,
      source: participant.source,
      deviceName: participant.deviceName,
      intensityPct: participant.intensityPct,
      kcalSession: participant.kcalSession
    });
  }
  return true;
}

function participantIdFromBody(body, fallback) {
  const raw = body?.participantId || body?.studentId || body?.id || fallback;
  return String(raw || '').trim().slice(0, 64);
}

function publicBase(protocol, hostHint) {
  const ips = localIps();
  const host = hostHint || ips[0] || 'localhost';
  return `${protocol}://${host}:${PORT}`;
}

// --- HTTP API ---

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'hrcast',
    room: ROOM,
    https: USE_HTTPS,
    participants: participants.size,
    workout: workouts ? workouts.status() : { active: false, workout: null },
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/api/health', (_req, res) => {
  res.redirect(302, '/health');
});

app.get('/api/info', (req, res) => {
  const proto = req.secure || USE_HTTPS ? 'https' : 'http';
  const ips = localIps();
  const base = publicBase(proto, ips[0]);
  res.json({
    room: ROOM,
    port: PORT,
    https: USE_HTTPS,
    ips,
    participantUrl: `${base}/participant.html?room=${encodeURIComponent(ROOM)}`,
    studentUrl: `${base}/participant.html?room=${encodeURIComponent(ROOM)}`,
    coachUrl: `${base}/`,
    mode: 'hyperate-or-ble',
    architecture: 'watch-hyperate → server-ws | watch-ble → phone-webbluetooth → server',
    hyperate: {
      tokenSource: 'participant-profile',
      hint: 'Ogni allievo inserisce il proprio token API HypeRate in profilazione'
    }
  });
});

/** QR PNG per il telefono — evita localhost e CDN esterni. */
app.get('/api/qr', async (req, res) => {
  try {
    const ips = localIps();
    const proto = USE_HTTPS ? 'https' : 'http';
    let target = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!target) {
      const ip = typeof req.query.ip === 'string' && req.query.ip.trim()
        ? req.query.ip.trim()
        : ips[0] || 'localhost';
      target = `${proto}://${ip}:${PORT}/participant.html?room=${encodeURIComponent(ROOM)}`;
    }
    // Blocca data:/javascript: ecc.
    if (!/^https?:\/\//i.test(target)) {
      res.status(400).json({ ok: false, error: 'url non valida' });
      return;
    }
    res.type('png');
    res.setHeader('Cache-Control', 'no-store');
    await QRCode.toFileStream(res, target, {
      type: 'png',
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a1210', light: '#ffffff' }
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  }
});

app.get('/api/participants', (_req, res) => {
  pruneStale();
  res.json({ room: ROOM, participants: rosterPayload() });
});

app.get('/api/students', (_req, res) => {
  pruneStale();
  res.json({ room: ROOM, students: rosterPayload() });
});

app.get('/api/stream', (req, res) => {
  const since = Number(req.query.since) || 0;
  const events = recentEvents.filter((e) => e.t > since);
  res.json({ room: ROOM, events, count: events.length });
});

/**
 * Ingest HTTP (fallback se WebSocket non disponibile).
 * Body: { participantId, bpm, t?, source?, deviceName?, name?, quality? }
 */
/**
 * Registrazione HTTP (senza BPM) — utile se WebSocket non è ancora su.
 * Body: { participantId, name?, room?, profile? }
 */
app.post('/api/register', (req, res) => {
  const body = req.body || {};
  const id = participantIdFromBody(body);
  if (!id) {
    res.status(400).json({ ok: false, error: 'serve participantId' });
    return;
  }
  applyProfile(id, body.profile, body.name, body.room || ROOM);
  res.json({ ok: true, participantId: id, room: ROOM });
});

/** Aggiorna profilo biometrico (altezza, peso, sesso, età, FC riposo/max). */
app.post('/api/profile', (req, res) => {
  const body = req.body || {};
  const id = participantIdFromBody(body);
  if (!id) {
    res.status(400).json({ ok: false, error: 'serve participantId' });
    return;
  }
  const p = applyProfile(id, body.profile || body, body.name, body.room || ROOM);
  res.json({
    ok: true,
    participantId: id,
    profile: p.profile,
    maxHr: WocMetrics.resolveMaxHr(p.profile),
    restingHr: WocMetrics.resolveRestHr(p.profile)
  });
});

app.post('/api/bpm', (req, res) => {
  const body = req.body || {};
  const ok = recordBpm({
    participantId: participantIdFromBody(body),
    name: body.name,
    bpm: body.bpm,
    t: body.t,
    source: body.source || 'http',
    deviceName: body.deviceName,
    quality: body.quality,
    room: body.room || ROOM,
    profile: body.profile,
    intensityPct: body.intensityPct,
    kcalDelta: body.kcalDelta
  });
  if (!ok) {
    res.status(400).json({ ok: false, error: 'payload non valido (serve participantId + bpm)' });
    return;
  }
  res.json({ ok: true, participantId: participantIdFromBody(body) });
});

app.post('/api/ingest', (req, res) => {
  const body = req.body || {};
  const ok = recordBpm({
    participantId: participantIdFromBody(body),
    name: body.name,
    bpm: body.bpm,
    t: body.t,
    source: body.source || 'http',
    deviceName: body.deviceName,
    quality: body.quality,
    room: body.room || ROOM,
    profile: body.profile,
    intensityPct: body.intensityPct,
    kcalDelta: body.kcalDelta
  });
  if (!ok) {
    res.status(400).json({ ok: false, error: 'payload non valido (serve participantId + bpm)' });
    return;
  }
  res.json({ ok: true, participantId: participantIdFromBody(body) });
});

function createServer() {
  if (!USE_HTTPS) {
    return http.createServer(app);
  }
  const { keyPath, certPath, created } = ensureCerts();
  if (created) console.log('[TLS] Certificato self-signed generato in certs/');
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  return https.createServer({ key, cert }, app);
}

const server = createServer();
io = new Server(server, { cors: { origin: '*' } });

workouts = createWorkoutStore({
  room: ROOM,
  onChange: () => broadcastWorkout()
});

/** Una WebSocket HypeRate per ogni partecipante (token sul server). */
const hyperate = createHypeRateHub({
  onBpm: (evt) => recordBpm(evt),
  onAlive: (participantId) => {
    const p = participants.get(participantId);
    if (p) p.lastSeen = Date.now();
  },
  onStatus: ({ participantId, status, detail }) => {
    const p = participants.get(participantId);
    if (p && status !== 'left' && status !== 'error') {
      p.lastSeen = Date.now();
      p.source = 'hyperate';
    }
    io.emit('hyperate:status', { participantId, status, detail });
  }
});

app.get('/api/hyperate/status', (_req, res) => {
  res.json({
    tokenSource: 'participant-profile',
    subscriptions: hyperate.list()
  });
});

/**
 * Avvia sottoscrizione HypeRate per un partecipante (HTTP fallback).
 * Body: { participantId, hyperateId, hyperateToken, name?, room?, profile? }
 */
app.post('/api/hyperate/subscribe', (req, res) => {
  const body = req.body || {};
  const participantId = participantIdFromBody(body);
  const hyperateId = hyperate.normalizeId(body.hyperateId || body.sessionId || body.id);
  const hyperateToken = hyperate.normalizeToken(
    body.hyperateToken || body.token || body.apiToken
  );
  if (!participantId || !hyperateId) {
    res.status(400).json({ ok: false, error: 'serve participantId e hyperateId' });
    return;
  }
  if (!hyperateToken) {
    res.status(400).json({
      ok: false,
      error: 'serve hyperateToken (token API inserito nel profilo)'
    });
    return;
  }
  upsertParticipant(participantId, body.name, body.room || ROOM, body.profile);
  const result = hyperate.subscribe({
    participantId,
    hyperateId,
    token: hyperateToken,
    name: body.name,
    room: body.room || ROOM
  });
  broadcastRoster();
  res.json(result);
});

app.post('/api/hyperate/unsubscribe', (req, res) => {
  const participantId = participantIdFromBody(req.body || {});
  if (!participantId) {
    res.status(400).json({ ok: false, error: 'serve participantId' });
    return;
  }
  hyperate.unsubscribe(participantId);
  res.json({ ok: true });
});

/** Stato allenamento corrente */
app.get('/api/workout', (_req, res) => {
  res.json(workouts.status());
});

/** Avvia registrazione allenamento. Body: { title?, referenceWorkoutId? } */
app.post('/api/workout/start', (req, res) => {
  const result = workouts.start({
    title: req.body?.title,
    room: ROOM,
    referenceWorkoutId: req.body?.referenceWorkoutId
  });
  res.status(result.ok ? 200 : 409).json(result);
});

/** Termina e salva allenamento corrente. Body opzionale: { reason?: 'manual'|'api' } */
app.post('/api/workout/stop', (req, res) => {
  const reason = req.body?.reason === 'api' ? 'api' : 'manual';
  const result = workouts.stop({ reason });
  res.status(result.ok ? 200 : 409).json(result);
});

/**
 * Confronto FEI tra due sessioni.
 * Query: a=<workoutId>&b=<referenceId>  (a = attuale / nuovo, b = riferimento)
 * Oppure senza query: snapshot live se REC + riferimento.
 */
app.get('/api/workout/compare', (req, res) => {
  const a = String(req.query.a || '').trim();
  const b = String(req.query.b || '').trim();
  if (!a && !b) {
    const st = workouts.status();
    if (st.compare) {
      res.json({ ok: true, live: true, compare: st.compare });
      return;
    }
    res.status(404).json({ ok: false, error: 'nessun confronto attivo' });
    return;
  }
  if (!a || !b) {
    res.status(400).json({ ok: false, error: 'servono query a e b (id allenamenti)' });
    return;
  }
  const nowW = workouts.get(a);
  const refW = workouts.get(b);
  if (!nowW || !refW) {
    res.status(404).json({ ok: false, error: 'allenamento non trovato' });
    return;
  }
  const compare = workouts.compareWorkouts(nowW, refW);
  res.json({ ok: true, live: false, compare });
});

/** Elenco storico (senza serie complete). Query: limit?, participantId? */
app.get('/api/workouts', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const participantId = String(req.query.participantId || '').trim();
  const fetchLimit = participantId ? Math.min(200, Math.max(limit, 80)) : limit;
  let list = workouts.list({ limit: fetchLimit });
  if (participantId) {
    list = list
      .map((w) => {
        const mine = (w.participants || []).find((p) => p.id === participantId);
        if (!mine) return null;
        return {
          ...w,
          mySamples: mine.samples || 0,
          myName: mine.name || null
        };
      })
      .filter(Boolean)
      .slice(0, limit);
  }
  res.json({ workouts: list });
});

/** Dettaglio allenamento (con campioni) */
app.get('/api/workouts/:id', (req, res) => {
  const w = workouts.get(req.params.id);
  if (!w) {
    res.status(404).json({ ok: false, error: 'allenamento non trovato' });
    return;
  }
  res.json(w);
});

/** Cancella allenamento dallo storico. Non consentito se in registrazione. */
app.delete('/api/workouts/:id', (req, res) => {
  const result = workouts.remove(req.params.id);
  if (result.ok) {
    res.json(result);
    return;
  }
  const status = result.error === 'allenamento non trovato' ? 404 : 409;
  res.status(status).json(result);
});

/** Rinomina allenamento. Body: { title? } — vuoto → "Allenamento" */
app.patch('/api/workouts/:id', (req, res) => {
  const result = workouts.rename(req.params.id, req.body?.title);
  if (result.ok) {
    res.json(result);
    return;
  }
  const status = result.error === 'allenamento non trovato' ? 404 : 409;
  res.status(status).json(result);
});

io.on('connection', (socket) => {
  console.log(`[WS] Client: ${socket.id}`);
  socket.emit('session-info', {
    room: ROOM,
    ips: localIps(),
    https: USE_HTTPS,
    mode: 'hyperate-or-ble',
    hyperateTokenSource: 'participant-profile'
  });
  socket.emit('lista-allievi', { room: ROOM, students: rosterPayload(), participants: rosterPayload() });
  socket.emit('workout:status', workouts.status());

  socket.on('workout:start', (payload, ack) => {
    const result = workouts.start({
      title: payload?.title,
      room: ROOM,
      referenceWorkoutId: payload?.referenceWorkoutId
    });
    if (typeof ack === 'function') ack(result);
  });

  socket.on('workout:stop', (payload, ack) => {
    const reason = payload?.reason === 'api' ? 'api' : 'manual';
    const result = workouts.stop({ reason });
    if (typeof ack === 'function') ack(result);
  });

  socket.on('participant:register', (payload, ack) => {
    const id = participantIdFromBody(payload, socket.id);
    const name = payload?.name;
    applyProfile(id, payload?.profile, name, payload?.room || ROOM);
    socket.data.participantId = id;
    socket.data.role = 'participant';
    console.log(`[WS] Registrato: ${participants.get(id)?.name} (${id})`);
    if (typeof ack === 'function') ack({ ok: true, participantId: id, room: ROOM });
  });

  socket.on('participant:profile', (payload, ack) => {
    const id = participantIdFromBody(payload, socket.data.participantId || socket.id);
    if (!id) {
      if (typeof ack === 'function') ack({ ok: false, error: 'serve participantId' });
      return;
    }
    const p = applyProfile(id, payload?.profile || payload, payload?.name, payload?.room || ROOM);
    socket.data.participantId = id;
    if (typeof ack === 'function') {
      ack({
        ok: true,
        participantId: id,
        profile: p.profile,
        maxHr: WocMetrics.resolveMaxHr(p.profile),
        restingHr: WocMetrics.resolveRestHr(p.profile)
      });
    }
  });

  // Alias legacy
  socket.on('student:register', (payload, ack) => {
    const id = participantIdFromBody(payload, socket.id);
    applyProfile(id, payload?.profile, payload?.name, payload?.room || ROOM);
    socket.data.participantId = id;
    socket.data.role = 'participant';
    if (typeof ack === 'function') ack({ ok: true, participantId: id, studentId: id, room: ROOM });
  });

  /**
   * Sottoscrivi il flusso HypeRate di questo allievo.
   * { participantId?, hyperateId, hyperateToken, name?, room?, profile? }
   */
  socket.on('participant:hyperate', (payload, ack) => {
    const id = participantIdFromBody(payload, socket.data.participantId || socket.id);
    const hyperateId = hyperate.normalizeId(
      payload?.hyperateId || payload?.sessionId || payload?.hyperate_id
    );
    const hyperateToken = hyperate.normalizeToken(
      payload?.hyperateToken || payload?.token || payload?.apiToken
    );
    if (!id || !hyperateId) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'serve hyperateId (codice sessione sull’app Watch)' });
      }
      return;
    }
    if (!hyperateToken) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'serve hyperateToken (inseriscilo nel profilo)' });
      }
      return;
    }
    applyProfile(id, payload?.profile, payload?.name, payload?.room || ROOM);
    socket.data.participantId = id;
    socket.data.role = 'participant';
    socket.data.hyperateId = hyperateId;
    const result = hyperate.subscribe({
      participantId: id,
      hyperateId,
      token: hyperateToken,
      name: payload?.name,
      room: payload?.room || ROOM
    });
    if (typeof ack === 'function') ack(result);
  });

  socket.on('participant:hyperate:stop', (payload, ack) => {
    const id = participantIdFromBody(payload, socket.data.participantId);
    if (id) hyperate.unsubscribe(id);
    socket.data.hyperateId = null;
    if (typeof ack === 'function') ack({ ok: true });
  });

  /**
   * Ingest WebSocket preferito (BLE / manuale):
   * { participantId, bpm, t, source, deviceName, name?, quality?, profile?, intensityPct? }
   */
  socket.on('participant:bpm', (payload) => {
    recordBpm({
      participantId: participantIdFromBody(payload, socket.data.participantId || socket.id),
      name: payload?.name,
      bpm: payload?.bpm,
      t: payload?.t,
      source: payload?.source || 'ble',
      deviceName: payload?.deviceName,
      quality: payload?.quality,
      room: payload?.room || ROOM,
      profile: payload?.profile,
      intensityPct: payload?.intensityPct,
      kcalDelta: payload?.kcalDelta
    });
  });

  socket.on('student:bpm', (payload) => {
    recordBpm({
      participantId: participantIdFromBody(payload, socket.data.participantId || socket.id),
      name: payload?.name,
      bpm: payload?.bpm,
      t: payload?.t || payload?.timestamp,
      source: payload?.source || 'ble',
      deviceName: payload?.deviceName,
      quality: payload?.quality,
      room: payload?.room || ROOM,
      profile: payload?.profile,
      intensityPct: payload?.intensityPct,
      kcalDelta: payload?.kcalDelta
    });
  });

  socket.on('disconnect', () => {
    // Non chiudere la WS HypeRate: i BPM continuano sul server anche se il telefono va in sleep.
    // Si chiude solo con participant:hyperate:stop / Esci / nuova sessione.
    console.log(`[WS] Disconnesso: ${socket.id}`);
  });
});

setInterval(pruneStale, 5000);

server.listen(PORT, '0.0.0.0', () => {
  const ips = localIps();
  const proto = USE_HTTPS ? 'https' : 'http';
  console.log(`[Server] HRcast — HypeRate + BLE gateway`);
  console.log(`[Server] Protocollo: ${proto.toUpperCase()}  porta ${PORT}  stanza ${ROOM}`);
  console.log(`[Coach]  ${proto}://localhost:${PORT}/`);
  for (const ip of ips) {
    console.log(`[Partecipante] ${proto}://${ip}:${PORT}/participant.html?room=${ROOM}`);
  }
  console.log('[HypeRate] Token per allievo (profilazione) — nessuna chiave globale ENV');
  console.log(`[Workout] Storico in ${workouts.dir}`);
  if (USE_HTTPS) {
    console.log('[TLS] Accetta il certificato self-signed sul telefono (una tantum).');
    console.log('[TLS] HTTPS=false per HTTP solo su localhost (Web Bluetooth non funziona da IP LAN).');
  }
  console.log('[Health] /health');
});

function shutdown() {
  try {
    workouts.dispose();
  } catch (err) {
    console.error('[Workout] Flush finale:', err.message);
  }
  hyperate.unsubscribeAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[Server]', err.message);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[Server]', msg);
});
