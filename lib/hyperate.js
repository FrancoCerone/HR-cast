/**
 * HypeRate multi-client hub.
 * Ogni partecipante ha la propria WebSocket verso app.hyperate.io (Phoenix channels).
 * Il token API è condiviso (HYPERATE_TOKEN in .env); ogni allievo fornisce solo l’ID sessione Watch.
 * Docs: https://github.com/HypeRate/DevDocs
 */
const WebSocket = require('ws');

const HYPERATE_WS =
  process.env.HYPERATE_WS_URL ||
  'wss://app.hyperate.io/socket/websocket';
const HEARTBEAT_MS = 10000;
const RECONNECT_MS = 2500;
const MAX_RECONNECT = 12;

function normalizeId(raw) {
  return String(raw || '')
    .trim()
    .replace(/^hr:/i, '')
    .slice(0, 64);
}

function normalizeToken(raw) {
  return String(raw || '')
    .trim()
    .slice(0, 256);
}

function parseMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      topic: data.topic,
      event: data.event,
      payload: data.payload || {},
      ref: data.ref
    };
  }

  if (Array.isArray(data) && data.length >= 5) {
    return {
      topic: data[2],
      event: data[3],
      payload: data[4] || {},
      ref: data[1]
    };
  }

  return null;
}

function extractBpm(payload) {
  if (payload == null) return null;
  if (typeof payload === 'number') return payload;
  const n = Number(
    payload.hr ?? payload.bpm ?? payload.heartRate ?? payload.heart_rate
  );
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{ onBpm: Function, onStatus?: Function, onAlive?: Function }} opts
 */
function createHypeRateHub({ onBpm, onStatus, onAlive }) {
  /** @type {Map<string, {
   *  participantId: string,
   *  hyperateId: string,
   *  token: string,
   *  name: string,
   *  room: string,
   *  ws: import('ws')|null,
   *  heartbeat: NodeJS.Timeout|null,
   *  reconnectTimer: NodeJS.Timeout|null,
   *  reconnectAttempts: number,
   *  intentionalClose: boolean,
   *  ref: number
   * }>} */
  const byParticipant = new Map();

  function emitStatus(participantId, status, detail) {
    if (typeof onStatus === 'function') {
      onStatus({ participantId, status, detail });
    }
  }

  function nextRef(entry) {
    entry.ref += 1;
    return String(entry.ref);
  }

  function sendJson(entry, msg) {
    if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) return;
    entry.ws.send(JSON.stringify(msg));
  }

  function startHeartbeat(entry) {
    stopHeartbeat(entry);
    entry.heartbeat = setInterval(() => {
      sendJson(entry, {
        topic: 'phoenix',
        event: 'heartbeat',
        payload: {},
        ref: nextRef(entry)
      });
      if (typeof onAlive === 'function') onAlive(entry.participantId);
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat(entry) {
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    entry.heartbeat = null;
  }

  function clearReconnect(entry) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  function buildUrl(token) {
    const u = new URL(HYPERATE_WS);
    u.searchParams.set('vsn', '2.0.0');
    if (token) u.searchParams.set('token', token);
    return u.toString();
  }

  function openSocket(entry) {
    clearReconnect(entry);
    stopHeartbeat(entry);

    if (entry.ws) {
      try {
        entry.ws.removeAllListeners();
        entry.ws.close();
      } catch (_) {}
      entry.ws = null;
    }

    const url = buildUrl(entry.token);
    const ws = new WebSocket(url, {
      headers: {
        Origin: process.env.HYPERATE_ORIGIN || 'https://app.hyperate.io'
      }
    });
    entry.ws = ws;
    entry.intentionalClose = false;

    ws.on('open', () => {
      entry.reconnectAttempts = 0;
      sendJson(entry, {
        topic: `hr:${entry.hyperateId}`,
        event: 'phx_join',
        payload: {},
        ref: nextRef(entry)
      });
      startHeartbeat(entry);
      emitStatus(entry.participantId, 'joined', `HypeRate ${entry.hyperateId}`);
      console.log(
        `[HypeRate] Join hr:${entry.hyperateId} → ${entry.name} (${entry.participantId})`
      );
    });

    ws.on('message', (buf) => {
      const msg = parseMessage(buf.toString());
      if (!msg) return;

      if (msg.event === 'phx_reply') {
        const status = msg.payload?.status;
        if (status === 'error') {
          const reason = msg.payload?.response?.reason || 'join rejected';
          emitStatus(entry.participantId, 'error', reason);
          console.warn(`[HypeRate] phx_reply error hr:${entry.hyperateId}:`, reason);
        } else if (status === 'ok') {
          emitStatus(entry.participantId, 'ready', `In ascolto ${entry.hyperateId}`);
        }
        return;
      }

      if (msg.event === 'hr_update' || msg.event === 'hr' || msg.event === 'hr_feed') {
        const bpm = extractBpm(msg.payload);
        if (bpm == null) return;
        onBpm({
          participantId: entry.participantId,
          name: entry.name,
          bpm,
          t: Date.now(),
          source: 'hyperate',
          deviceName: `HypeRate ${entry.hyperateId}`,
          room: entry.room
        });
      }
    });

    ws.on('close', () => {
      stopHeartbeat(entry);
      entry.ws = null;
      if (entry.intentionalClose) return;
      if (!byParticipant.has(entry.participantId)) return;

      entry.reconnectAttempts += 1;
      if (entry.reconnectAttempts > MAX_RECONNECT) {
        emitStatus(entry.participantId, 'error', 'HypeRate: troppi tentativi di riconnessione');
        console.warn(`[HypeRate] Give up reconnect hr:${entry.hyperateId}`);
        return;
      }
      emitStatus(entry.participantId, 'reconnecting', `Tentativo ${entry.reconnectAttempts}`);
      entry.reconnectTimer = setTimeout(() => openSocket(entry), RECONNECT_MS);
    });

    ws.on('error', (err) => {
      console.warn(`[HypeRate] WS error hr:${entry.hyperateId}:`, err.message);
      emitStatus(entry.participantId, 'error', err.message);
    });
  }

  function subscribe({ participantId, hyperateId, token, name, room }) {
    const id = String(participantId || '').trim().slice(0, 64);
    const hrId = normalizeId(hyperateId);
    const apiToken = normalizeToken(token);
    if (!id || !hrId) {
      return { ok: false, error: 'serve participantId e hyperateId' };
    }
    if (!apiToken) {
      return { ok: false, error: 'HYPERATE_TOKEN non configurato sul server (.env)' };
    }

    const existing = byParticipant.get(id);
    if (
      existing &&
      existing.hyperateId === hrId &&
      existing.token === apiToken &&
      existing.ws?.readyState === WebSocket.OPEN
    ) {
      existing.name = name || existing.name;
      existing.room = room || existing.room;
      return { ok: true, hyperateId: hrId, reused: true };
    }

    if (existing) unsubscribe(id);

    const entry = {
      participantId: id,
      hyperateId: hrId,
      token: apiToken,
      name: String(name || 'Partecipante').trim().slice(0, 40) || 'Partecipante',
      room: room || 'spinning',
      ws: null,
      heartbeat: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      intentionalClose: false,
      ref: 0
    };
    byParticipant.set(id, entry);
    openSocket(entry);
    return { ok: true, hyperateId: hrId, reused: false };
  }

  function unsubscribe(participantId) {
    const id = String(participantId || '').trim();
    const entry = byParticipant.get(id);
    if (!entry) return false;

    entry.intentionalClose = true;
    clearReconnect(entry);
    stopHeartbeat(entry);

    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      try {
        sendJson(entry, {
          topic: `hr:${entry.hyperateId}`,
          event: 'phx_leave',
          payload: {},
          ref: nextRef(entry)
        });
      } catch (_) {}
      try {
        entry.ws.close();
      } catch (_) {}
    }

    byParticipant.delete(id);
    emitStatus(id, 'left', null);
    console.log(`[HypeRate] Leave hr:${entry.hyperateId} (${id})`);
    return true;
  }

  function unsubscribeAll() {
    for (const id of [...byParticipant.keys()]) unsubscribe(id);
  }

  function list() {
    return [...byParticipant.values()].map((e) => ({
      participantId: e.participantId,
      hyperateId: e.hyperateId,
      name: e.name,
      connected: e.ws?.readyState === WebSocket.OPEN
    }));
  }

  return {
    subscribe,
    unsubscribe,
    unsubscribeAll,
    list,
    normalizeId,
    normalizeToken
  };
}

module.exports = { createHypeRateHub, normalizeId, normalizeToken };
