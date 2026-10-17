/**
 * Storico allenamenti su filesystem (JSON).
 * data/workouts/index.json  — elenco sintetico
 * data/workouts/<id>.json   — sessione completa + campioni BPM
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WocMetrics = require('./metrics');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'workouts');
/** Minimo intervallo tra campioni per lo stesso partecipante (ms). */
const SAMPLE_MIN_MS = 1000;
/** Flush periodico su disco durante la registrazione. */
const FLUSH_MS = 5000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function makeId(now = Date.now()) {
  const d = new Date(now);
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '-',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0')
  ].join('');
  const rand = crypto.randomBytes(2).toString('hex');
  return `${stamp}-${rand}`;
}

function summarize(workout) {
  const participants = Object.values(workout.participants || {});
  return {
    id: workout.id,
    room: workout.room,
    title: workout.title,
    status: workout.status,
    startedAt: workout.startedAt,
    endedAt: workout.endedAt ?? null,
    sampleCount: workout.sampleCount || 0,
    participantCount: participants.length,
    referenceWorkoutId: workout.referenceWorkoutId || null,
    referenceTitle: workout.referenceTitle || null,
    compareMode: Boolean(workout.compareMode || workout.referenceWorkoutId),
    referenceDurationMs: workout.referenceDurationMs ?? null,
    autoStop: Boolean(workout.autoStop),
    autoStopAt: workout.autoStopAt ?? null,
    stopReason: workout.stopReason || null,
    participants: participants.map((p) => ({
      id: p.id,
      name: p.name,
      samples: (p.samples || []).length
    }))
  };
}

function referencePublicMeta(ref) {
  if (!ref || !ref.id) return null;
  return {
    id: ref.id,
    title: ref.title || 'Riferimento',
    startedAt: ref.startedAt || null,
    endedAt: ref.endedAt || null,
    sampleCount: ref.sampleCount || 0,
    participantCount: Object.keys(ref.participants || {}).length,
    durationMs: durationOfWorkout(ref)
  };
}

/** Durata effettiva di una sessione (endedAt, altrimenti ultimo sample). */
function durationOfWorkout(workout) {
  if (!workout || workout.startedAt == null) return null;
  const t0 = Number(workout.startedAt);
  if (!Number.isFinite(t0)) return null;
  if (workout.endedAt != null && Number.isFinite(Number(workout.endedAt))) {
    return Math.max(0, Number(workout.endedAt) - t0);
  }
  let maxT = null;
  for (const p of Object.values(workout.participants || {})) {
    const samples = Array.isArray(p.samples) ? p.samples : [];
    if (!samples.length) continue;
    const t = Number(samples[samples.length - 1].t);
    if (!Number.isFinite(t)) continue;
    if (maxT == null || t > maxT) maxT = t;
  }
  if (maxT == null) return null;
  return Math.max(0, maxT - t0);
}

/**
 * Policy automazione per una lezione di confronto.
 * Usata da start() e riusabile da job esterni.
 */
function buildCompareAutomation(refWorkout) {
  const durationMs = durationOfWorkout(refWorkout);
  if (durationMs == null || durationMs <= 0) {
    return {
      compareMode: true,
      autoStop: false,
      referenceDurationMs: null,
      reason: 'riferimento senza durata valida'
    };
  }
  return {
    compareMode: true,
    autoStop: true,
    referenceDurationMs: durationMs,
    reason: null
  };
}

/**
 * @param {{ dir?: string, room?: string, onChange?: Function }} opts
 */
function createWorkoutStore({ dir = DEFAULT_DIR, room = 'spinning', onChange } = {}) {
  ensureDir(dir);
  const indexPath = path.join(dir, 'index.json');
  const fileFor = (id) => path.join(dir, `${id}.json`);

  /** @type {object|null} */
  let active = null;
  /** Ultimo allenamento completato (per dashboard riepilogo). */
  let lastCompleted = null;
  /** Workout di riferimento completo (in memoria durante REC). */
  let referenceFull = null;
  /**
   * Lezione aperta in dashboard coach (riepilogo, non LIVE).
   * Usata come riferimento FEI se lo start esterno non passa un id esplicito.
   */
  let openedLessonId = null;
  /** @type {Map<string, number>} ultimo timestamp campione per partecipante */
  const lastSampleAt = new Map();
  let dirty = false;
  let flushTimer = null;
  let statusTimer = null;
  let statusPending = false;
  /** Timer stop automatico in modalità compare. */
  let autoStopTimer = null;

  function emit() {
    if (typeof onChange === 'function') onChange(publicStatus());
  }

  function clearAutoStopTimer() {
    if (!autoStopTimer) return;
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }

  function scheduleAutoStop() {
    clearAutoStopTimer();
    if (!active || active.status !== 'recording') return;
    if (!active.autoStop || !active.autoStopAt) return;
    const delay = Math.max(0, Number(active.autoStopAt) - Date.now());
    autoStopTimer = setTimeout(() => {
      autoStopTimer = null;
      if (!active || active.status !== 'recording') return;
      console.log(
        `[Workout] Auto-stop compare @ fine riferimento (${active.referenceDurationMs} ms)`
      );
      stop({ reason: 'auto-compare' });
    }, delay);
  }

  /** Cintura di sicurezza se il timer è saltato (es. sleep OS). */
  function maybeAutoStopNow() {
    if (!active || active.status !== 'recording') return false;
    if (!active.autoStop || !active.autoStopAt) return false;
    if (Date.now() < Number(active.autoStopAt)) return false;
    stop({ reason: 'auto-compare' });
    return true;
  }

  /** Aggiorna la dashboard senza floodare (campioni frequenti). */
  function emitThrottled() {
    if (statusPending) return;
    statusPending = true;
    statusTimer = setTimeout(() => {
      statusPending = false;
      statusTimer = null;
      emit();
    }, 2000);
  }

  function loadIndex() {
    const raw = readJson(indexPath, { workouts: [] });
    return Array.isArray(raw.workouts) ? raw.workouts : [];
  }

  function saveIndexEntry(summary) {
    const list = loadIndex().filter((w) => w.id !== summary.id);
    list.unshift(summary);
    writeJsonAtomic(indexPath, { workouts: list.slice(0, 500) });
  }

  function persistActive() {
    if (!active) return;
    writeJsonAtomic(fileFor(active.id), active);
    saveIndexEntry(summarize(active));
    dirty = false;
  }

  function scheduleFlush() {
    if (flushTimer || !active || active.status !== 'recording') return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (dirty && active) persistActive();
    }, FLUSH_MS);
  }

  function buildCompareSnapshot() {
    if (!active || active.status !== 'recording' || !referenceFull) return null;

    const now = Date.now();
    const elapsedMs = Math.max(0, now - (active.startedAt || now));
    const refDur = Math.max(
      0,
      (referenceFull.endedAt || referenceFull.startedAt || 0) - (referenceFull.startedAt || 0)
    );
    const compareMs = refDur > 0 ? Math.min(elapsedMs, refDur) : elapsedMs;

    const byId = {};
    const feiList = [];
    const dIntList = [];
    const dBpmList = [];
    const dZoneList = [];
    const dKcalList = [];

    for (const p of Object.values(active.participants || {})) {
      const refP = WocMetrics.matchReferenceParticipant(referenceFull, p.id, p.name);
      if (!refP) {
        byId[p.id] = {
          id: p.id,
          name: p.name,
          matched: false,
          fei: null,
          deltas: null,
          headlinePp: null,
          now: null,
          ref: null
        };
        continue;
      }

      const cmp = WocMetrics.compareAtElapsed(active, referenceFull, p, refP, compareMs, {
        nowFullMs: elapsedMs
      });
      byId[p.id] = {
        id: p.id,
        name: p.name,
        matched: true,
        fei: cmp.fei,
        headlinePp: cmp.headlinePp,
        deltas: cmp.deltas,
        now: cmp.now,
        ref: cmp.ref
      };
      if (cmp.fei != null) feiList.push(cmp.fei);
      if (cmp.deltas.intensity != null) dIntList.push(cmp.deltas.intensity);
      if (cmp.deltas.bpm != null) dBpmList.push(cmp.deltas.bpm);
      if (cmp.deltas.zoneHigh != null) dZoneList.push(cmp.deltas.zoneHigh);
      if (cmp.deltas.kcal != null) dKcalList.push(cmp.deltas.kcal);
    }

    const avg = (arr) =>
      arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;

    return {
      elapsedMs: compareMs,
      wallElapsedMs: elapsedMs,
      reference: referencePublicMeta(referenceFull),
      participants: byId,
      classAvg: {
        fei: avg(feiList),
        deltas: {
          intensity: avg(dIntList),
          bpm: avg(dBpmList),
          zoneHigh: avg(dZoneList),
          kcal: avg(dKcalList)
        },
        matchedCount: feiList.length
      }
    };
  }

  function publicStatus() {
    const automationFor = (w) => {
      if (!w) return null;
      const autoStopAt = w.autoStopAt || null;
      return {
        compareMode: Boolean(w.compareMode || w.referenceWorkoutId),
        autoStop: Boolean(w.autoStop),
        autoStopAt,
        referenceDurationMs: w.referenceDurationMs ?? null,
        remainingMs:
          autoStopAt && w.status === 'recording'
            ? Math.max(0, Number(autoStopAt) - Date.now())
            : null,
        stopReason: w.stopReason || null
      };
    };

    if (!active) {
      return {
        active: false,
        workout: null,
        completed: lastCompleted ? summarize(lastCompleted) : null,
        reference: null,
        compare: null,
        automation: lastCompleted ? automationFor(lastCompleted) : null,
        openedLessonId
      };
    }
    return {
      active: active.status === 'recording',
      workout: summarize(active),
      completed: lastCompleted ? summarize(lastCompleted) : null,
      reference:
        referencePublicMeta(referenceFull) ||
        (active.referenceWorkoutId
          ? {
              id: active.referenceWorkoutId,
              title: active.referenceTitle || 'Riferimento',
              startedAt: null,
              endedAt: null,
              sampleCount: null,
              participantCount: null,
              durationMs: active.referenceDurationMs ?? null
            }
          : null),
      compare: buildCompareSnapshot(),
      automation: automationFor(active),
      openedLessonId
    };
  }

  /**
   * Imposta / azzera la lezione aperta in dashboard (riepilogo coach).
   * @param {string|null|undefined} workoutId
   */
  function setOpenedLesson(workoutId) {
    const id = String(workoutId || '').trim();
    if (!id) {
      openedLessonId = null;
      return { ok: true, openedLessonId: null };
    }
    const w = get(id);
    if (!w || !w.id) {
      return { ok: false, error: 'allenamento non trovato', openedLessonId };
    }
    if (w.status === 'recording') {
      return {
        ok: false,
        error: 'non puoi aprire una sessione in corso',
        openedLessonId
      };
    }
    openedLessonId = id;
    return { ok: true, openedLessonId };
  }

  function getOpenedLessonId() {
    return openedLessonId;
  }

  /** Chiude eventuali sessioni lasciate aperte (crash / restart). */
  function recoverOrphans() {
    for (const entry of loadIndex()) {
      if (entry.status !== 'recording') continue;
      const full = readJson(fileFor(entry.id), null);
      if (!full || full.status !== 'recording') continue;
      full.status = 'completed';
      full.endedAt = full.endedAt || Date.now();
      full.note = full.note || 'chiuso automaticamente al riavvio server';
      writeJsonAtomic(fileFor(full.id), full);
      saveIndexEntry(summarize(full));
      console.log(`[Workout] Sessione orfana chiusa: ${full.id}`);
    }
  }

  recoverOrphans();

  function start({ title, room: roomOverride, referenceWorkoutId } = {}) {
    if (active && active.status === 'recording') {
      return { ok: false, error: 'allenamento già in corso', workout: summarize(active) };
    }

    const now = Date.now();
    const id = makeId(now);
    let refId = String(referenceWorkoutId || '').trim();
    let refTitle = null;
    referenceFull = null;

    if (refId) {
      const ref = get(refId);
      if (!ref || !ref.id) {
        return { ok: false, error: 'allenamento di riferimento non trovato', workout: null };
      }
      if (ref.status === 'recording') {
        return {
          ok: false,
          error: 'il riferimento non può essere una sessione in corso',
          workout: null
        };
      }
      referenceFull = ref;
      refId = ref.id;
      refTitle = ref.title || 'Riferimento';
    } else {
      refId = null;
    }

    active = {
      id,
      room: roomOverride || room,
      title: String(title || '').trim().slice(0, 80) ||
        `Allenamento ${new Date(now).toLocaleString('it-IT', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })}`,
      status: 'recording',
      startedAt: now,
      endedAt: null,
      sampleCount: 0,
      participants: {},
      referenceWorkoutId: refId,
      referenceTitle: refTitle,
      compareMode: Boolean(refId),
      referenceDurationMs: null,
      autoStop: false,
      autoStopAt: null,
      stopReason: null
    };

    if (refId && referenceFull) {
      const policy = buildCompareAutomation(referenceFull);
      active.compareMode = policy.compareMode;
      active.referenceDurationMs = policy.referenceDurationMs;
      active.autoStop = policy.autoStop;
      active.autoStopAt = policy.autoStop ? now + policy.referenceDurationMs : null;
      if (policy.reason) {
        console.log(`[Workout] Compare senza auto-stop: ${policy.reason}`);
      }
    }

    lastSampleAt.clear();
    dirty = true;
    // Lasciando il riepilogo per la REC, la lezione aperta non serve più
    openedLessonId = null;
    persistActive();
    scheduleAutoStop();
    console.log(
      `[Workout] Avviato ${active.id} — ${active.title}` +
        (refId
          ? ` · FEI vs ${refId}` +
            (active.autoStop
              ? ` · auto-stop ${Math.round(active.referenceDurationMs / 1000)}s`
              : '')
          : '')
    );
    emit();
    return {
      ok: true,
      workout: summarize(active),
      reference: referencePublicMeta(referenceFull),
      automation: publicStatus().automation
    };
  }

  /**
   * Termina la sessione.
   * @param {{ reason?: 'manual'|'auto-compare'|'api' }} [opts]
   */
  function stop(opts = {}) {
    if (!active || active.status !== 'recording') {
      return { ok: false, error: 'nessun allenamento in corso', workout: null };
    }
    const reason = opts.reason || 'manual';
    clearAutoStopTimer();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
      statusPending = false;
    }

    active.status = 'completed';
    active.stopReason = reason;
    // In auto-compare allinea endedAt alla durata del riferimento
    if (reason === 'auto-compare' && active.autoStopAt) {
      active.endedAt = Math.min(Date.now(), Number(active.autoStopAt));
    } else {
      active.endedAt = Date.now();
    }

    persistActive();
    const full = active;
    lastCompleted = full;
    const summary = summarize(full);
    console.log(
      `[Workout] Terminato ${summary.id} (${reason}) — ${summary.sampleCount} campioni, ` +
        `${summary.participantCount} partecipanti`
    );
    active = null;
    referenceFull = null;
    lastSampleAt.clear();
    dirty = false;
    emit();
    return {
      ok: true,
      workout: summary,
      detail: full,
      automation: {
        compareMode: Boolean(full.compareMode || full.referenceWorkoutId),
        autoStop: Boolean(full.autoStop),
        autoStopAt: full.autoStopAt || null,
        referenceDurationMs: full.referenceDurationMs ?? null,
        remainingMs: null,
        stopReason: full.stopReason || reason
      }
    };
  }

  /**
   * Registra un campione BPM se c’è un allenamento attivo.
   * Throttle per partecipante (default 1/s).
   */
  function recordSample({ participantId, name, bpm, t, source, deviceName, intensityPct, kcalSession }) {
    if (maybeAutoStopNow()) return false;
    if (!active || active.status !== 'recording') return false;

    const id = String(participantId || '').trim().slice(0, 64);
    if (!id) return false;
    const value = Math.round(Number(bpm));
    if (!Number.isFinite(value) || value <= 0 || value > 400) return false;

    const ts = Number(t) || Date.now();
    const prev = lastSampleAt.get(id) || 0;
    if (ts - prev < SAMPLE_MIN_MS) return false;
    lastSampleAt.set(id, ts);

    let p = active.participants[id];
    if (!p) {
      p = {
        id,
        name: String(name || 'Partecipante').trim().slice(0, 40) || 'Partecipante',
        source: source || null,
        deviceName: deviceName || null,
        kcalSession: 0,
        samples: []
      };
      active.participants[id] = p;
    } else {
      if (name) p.name = String(name).trim().slice(0, 40) || p.name;
      if (source) p.source = source;
      if (deviceName) p.deviceName = String(deviceName).slice(0, 80);
    }

    const pct =
      intensityPct != null && Number.isFinite(Number(intensityPct))
        ? Math.round(Number(intensityPct))
        : null;
    const sample = { t: ts, bpm: value };
    if (pct != null) sample.intensityPct = pct;
    p.samples.push(sample);

    if (kcalSession != null && Number.isFinite(Number(kcalSession))) {
      p.kcalSession = Math.max(0, Number(kcalSession));
    }

    active.sampleCount = (active.sampleCount || 0) + 1;
    dirty = true;
    scheduleFlush();
    emitThrottled();
    return true;
  }

  function list({ limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return loadIndex().slice(0, n);
  }

  function get(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe !== id) return null;
    return readJson(fileFor(safe), null);
  }

  /**
   * Cancella un allenamento dallo storico (file + indice).
   * Non consente di cancellare la sessione in registrazione.
   */
  function remove(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe !== id) {
      return { ok: false, error: 'id non valido' };
    }
    if (active && active.id === safe) {
      return { ok: false, error: 'non puoi cancellare un allenamento in corso' };
    }
    const full = get(safe);
    if (!full) {
      return { ok: false, error: 'allenamento non trovato' };
    }

    const list = loadIndex().filter((w) => w.id !== safe);
    writeJsonAtomic(indexPath, { workouts: list });

    try {
      fs.unlinkSync(fileFor(safe));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn(`[Workout] Eliminazione file fallita ${safe}:`, err.message);
      }
    }

    if (lastCompleted && lastCompleted.id === safe) {
      lastCompleted = null;
    }
    if (openedLessonId === safe) {
      openedLessonId = null;
    }

    console.log(`[Workout] Eliminato ${safe}`);
    emit();
    return { ok: true, id: safe };
  }

  /**
   * Rinomina un allenamento (titolo opzionale; stringa vuota → titolo di default).
   */
  function rename(id, title) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe !== id) {
      return { ok: false, error: 'id non valido' };
    }
    const nextTitle =
      String(title == null ? '' : title)
        .trim()
        .slice(0, 80) || 'Allenamento';

    if (active && active.id === safe) {
      active.title = nextTitle;
      persistActive();
      emit();
      return { ok: true, workout: summarize(active) };
    }

    const full = get(safe);
    if (!full) {
      return { ok: false, error: 'allenamento non trovato' };
    }
    full.title = nextTitle;
    writeJsonAtomic(fileFor(safe), full);
    saveIndexEntry(summarize(full));
    if (lastCompleted && lastCompleted.id === safe) {
      lastCompleted = full;
    }
    emit();
    return { ok: true, workout: summarize(full) };
  }

  /**
   * Confronto finale (o live) tra due workout completi.
   * Se elapsedMs omesso: min(durata A, durata B).
   */
  function compareWorkouts(nowWorkout, refWorkout, elapsedMs) {
    if (!nowWorkout || !refWorkout) return null;
    const nowDur = Math.max(
      0,
      (nowWorkout.endedAt || nowWorkout.startedAt || 0) - (nowWorkout.startedAt || 0)
    );
    const refDur = Math.max(
      0,
      (refWorkout.endedAt || refWorkout.startedAt || 0) - (refWorkout.startedAt || 0)
    );
    let compareMs;
    if (elapsedMs != null && Number.isFinite(Number(elapsedMs))) {
      compareMs = Math.max(0, Number(elapsedMs));
    } else {
      const a = nowDur > 0 ? nowDur : Infinity;
      const b = refDur > 0 ? refDur : Infinity;
      compareMs = Math.min(a, b);
      if (!Number.isFinite(compareMs)) compareMs = 0;
    }

    const byId = {};
    const feiList = [];

    for (const p of Object.values(nowWorkout.participants || {})) {
      const refP = WocMetrics.matchReferenceParticipant(refWorkout, p.id, p.name);
      if (!refP) {
        byId[p.id] = { id: p.id, name: p.name, matched: false, fei: null };
        continue;
      }
      const cmp = WocMetrics.compareAtElapsed(nowWorkout, refWorkout, p, refP, compareMs, {
        nowFullMs: nowDur
      });
      byId[p.id] = {
        id: p.id,
        name: p.name,
        matched: true,
        fei: cmp.fei,
        headlinePp: cmp.headlinePp,
        deltas: cmp.deltas,
        now: cmp.now,
        ref: cmp.ref
      };
      if (cmp.fei != null) feiList.push(cmp.fei);
    }

    const classFei = feiList.length
      ? Math.round((feiList.reduce((a, b) => a + b, 0) / feiList.length) * 10) / 10
      : null;

    return {
      elapsedMs: compareMs,
      reference: referencePublicMeta(refWorkout),
      workout: { id: nowWorkout.id, title: nowWorkout.title },
      participants: byId,
      classAvg: { fei: classFei, matchedCount: feiList.length }
    };
  }

  function dispose() {
    clearAutoStopTimer();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
      statusPending = false;
    }
    if (active && dirty) persistActive();
  }

  return {
    start,
    stop,
    recordSample,
    list,
    get,
    remove,
    rename,
    compareWorkouts,
    setOpenedLesson,
    getOpenedLessonId,
    status: publicStatus,
    dispose,
    get dir() {
      return dir;
    },
    get isRecording() {
      return Boolean(active && active.status === 'recording');
    }
  };
}

module.exports = {
  createWorkoutStore,
  SAMPLE_MIN_MS,
  durationOfWorkout,
  buildCompareAutomation
};
