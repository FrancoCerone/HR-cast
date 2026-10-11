/**
 * Metriche HR condivise (Node + browser).
 * Intensità: Karvonen %HRR se FC riposo + max note; altrimenti % di FCmax.
 * Calorie: Keytel et al. (kcal/min da FC, peso, età, sesso).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.WocMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_MAX_HR = 185;
  const DEFAULT_REST_HR = 60;

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function num(v, fallback) {
    if (fallback === undefined) fallback = null;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Tanaka 2001: 208 − 0.7 × età */
  function estimateMaxHr(age) {
    const a = num(age);
    if (a == null || a < 10 || a > 100) return null;
    return Math.round(208 - 0.7 * a);
  }

  /**
   * Stima FC a riposo tipica (non misurata).
   * Valori medi adulti; meglio misurare al mattino a riposo.
   */
  function estimateRestingHr(sex, age) {
    const a = num(age);
    let base = 65;
    if (sex === 'f') base = 70;
    else if (sex === 'm') base = 62;
    if (a != null) {
      if (a < 30) base -= 2;
      else if (a >= 50) base += 3;
    }
    return clamp(Math.round(base), 40, 100);
  }

  function resolveMaxHr(profile) {
    const manual = num(profile && profile.maxHr);
    if (manual != null && manual > 80 && manual < 250) return Math.round(manual);
    const est = estimateMaxHr(profile && profile.age);
    if (est != null) return est;
    return DEFAULT_MAX_HR;
  }

  function resolveRestHr(profile) {
    const manual = num(profile && profile.restingHr);
    if (manual != null && manual >= 30 && manual <= 120) return Math.round(manual);
    const est = estimateRestingHr(profile && profile.sex, profile && profile.age);
    if (est != null) return est;
    return DEFAULT_REST_HR;
  }

  function intensityPct(bpm, profile) {
    const hr = num(bpm);
    if (hr == null || hr <= 0) return null;
    const maxHr = resolveMaxHr(profile);
    const restHr = resolveRestHr(profile);
    const span = maxHr - restHr;
    if (span > 20) {
      return clamp(Math.round(((hr - restHr) / span) * 100), 0, 100);
    }
    return clamp(Math.round((hr / maxHr) * 100), 0, 100);
  }

  function kcalPerMinute(bpm, profile) {
    const hr = num(bpm);
    const weight = num(profile && profile.weightKg);
    const age = num(profile && profile.age);
    if (hr == null || weight == null || age == null) return null;
    if (weight < 30 || weight > 250 || age < 10 || age > 100) return null;

    const sex = profile && profile.sex;
    let kcalMin;
    if (sex === 'f') {
      kcalMin = (-20.4022 + 0.4472 * hr - 0.1263 * weight + 0.074 * age) / 4.184;
    } else if (sex === 'm') {
      kcalMin = (-55.0969 + 0.6309 * hr + 0.1988 * weight + 0.2017 * age) / 4.184;
    } else {
      const m = (-55.0969 + 0.6309 * hr + 0.1988 * weight + 0.2017 * age) / 4.184;
      const f = (-20.4022 + 0.4472 * hr - 0.1263 * weight + 0.074 * age) / 4.184;
      kcalMin = (m + f) / 2;
    }
    return kcalMin > 0 ? kcalMin : 0;
  }

  function normalizeProfile(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const sex = p.sex === 'm' || p.sex === 'f' || p.sex === 'x' ? p.sex : null;
    return {
      heightCm: num(p.heightCm),
      weightKg: num(p.weightKg),
      sex: sex,
      age: num(p.age),
      restingHr: num(p.restingHr),
      maxHr: num(p.maxHr),
      restingHrSource:
        p.restingHrSource === 'estimated' || p.restingHrSource === 'manual'
          ? p.restingHrSource
          : null,
      maxHrSource:
        p.maxHrSource === 'estimated' || p.maxHrSource === 'manual'
          ? p.maxHrSource
          : null
    };
  }

  function profileReadyForCalories(profile) {
    const p = normalizeProfile(profile);
    return p.weightKg != null && p.age != null && p.sex != null;
  }

  /** Soglia intensità per “zona alta” (Z3+Z4). */
  const HIGH_ZONE_PCT = 80;

  /**
   * Pesi FrancoEffortIndex (somma = 1).
   * Tutto espresso in “punti sforzo” (~punti %): FEI ≈ quanto sei più/meno intenso.
   */
  const FEI_WEIGHTS = {
    intensity: 0.55,
    bpm: 0.25,
    zoneHigh: 0.12,
    kcal: 0.08
  };

  /** Finestra rolling per il confronto live (ms). */
  const COMPARE_ROLLING_MS = 20000;

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function clampNum(n, lo, hi) {
    const v = num(n);
    if (v == null) return null;
    return clamp(v, lo, hi);
  }

  /**
   * Scostamento relativo (now − ref) / ref.
   * @param {number|null} now
   * @param {number|null} ref
   * @param {number} [floorAbs] minimo |ref| per evitare esplosioni
   */
  function relativeDelta(now, ref, floorAbs) {
    const a = num(now);
    const b = num(ref);
    if (a == null || b == null) return null;
    const floor = num(floorAbs, 0) || 0;
    const denom = Math.abs(b) < floor ? (b >= 0 ? floor : -floor) : b;
    if (denom === 0) return null;
    return (a - b) / denom;
  }

  function sampleIntensity(sample, profile) {
    if (!sample) return null;
    if (sample.intensityPct != null && Number.isFinite(Number(sample.intensityPct))) {
      return clamp(Math.round(Number(sample.intensityPct)), 0, 100);
    }
    return intensityPct(sample.bpm, profile);
  }

  /**
   * Metriche aggregate su una finestra temporale [0, elapsedMs] dall’inizio sessione.
   */
  function windowMetrics(samples, startedAt, elapsedMs, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const profile = options.profile || null;
    const t0 = num(startedAt);
    const windowMs = Math.max(0, num(elapsedMs, 0) || 0);
    const list = Array.isArray(samples) ? samples : [];
    const sliced = [];
    for (const s of list) {
      const t = num(s && s.t);
      if (t == null || t0 == null) continue;
      const elapsed = t - t0;
      if (elapsed < 0) continue;
      if (elapsed > windowMs) break;
      sliced.push(s);
    }

    let bpmSum = 0;
    let bpmN = 0;
    let intSum = 0;
    let intN = 0;
    let zoneHighMs = 0;
    let zoneTotalMs = 0;
    let kcalEst = 0;
    let hasKcalEst = false;

    for (let i = 0; i < sliced.length; i++) {
      const cur = sliced[i];
      const next = sliced[i + 1];
      const bpm = num(cur.bpm);
      if (bpm != null && bpm > 0) {
        bpmSum += bpm;
        bpmN += 1;
      }
      const pct = sampleIntensity(cur, profile);
      if (pct != null) {
        intSum += pct;
        intN += 1;
      }

      const dt =
        next != null
          ? Math.max(0, num(next.t, cur.t) - num(cur.t, 0))
          : Math.min(1000, Math.max(0, t0 != null ? t0 + windowMs - num(cur.t, t0) : 1000));
      if (pct != null && dt > 0) {
        zoneTotalMs += dt;
        if (pct >= HIGH_ZONE_PCT) zoneHighMs += dt;
      }

      if (profile && bpm != null && dt > 0) {
        const rate = kcalPerMinute(bpm, profile);
        if (rate != null) {
          kcalEst += rate * (dt / 60000);
          hasKcalEst = true;
        }
      }
    }

    let kcal = null;
    const kcalHint = num(options.kcalSession);
    if (kcalHint != null && kcalHint >= 0) {
      const fullMs = num(options.fullDurationMs);
      if (fullMs != null && fullMs > 0 && windowMs < fullMs - 500) {
        kcal = Math.round(kcalHint * (windowMs / fullMs) * 10) / 10;
      } else {
        kcal = Math.round(kcalHint * 10) / 10;
      }
    } else if (hasKcalEst) {
      kcal = Math.round(kcalEst * 10) / 10;
    }

    const durationMin = windowMs > 0 ? windowMs / 60000 : 0;
    const kcalPerMin = kcal != null && durationMin > 0.05 ? kcal / durationMin : null;

    return {
      avgBpm: bpmN ? Math.round(bpmSum / bpmN) : null,
      avgIntensity: intN ? Math.round(intSum / intN) : null,
      zoneHighShare: zoneTotalMs > 0 ? zoneHighMs / zoneTotalMs : null,
      kcal: kcal,
      kcalPerMin: kcalPerMin,
      sampleCount: sliced.length,
      durationMs: windowMs
    };
  }

  /**
   * Metriche rolling sulla coda [elapsedMs − windowMs, elapsedMs] — per delta live.
   */
  function rollingMetrics(samples, startedAt, elapsedMs, rollingMs, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const profile = options.profile || null;
    const t0 = num(startedAt);
    const endMs = Math.max(0, num(elapsedMs, 0) || 0);
    const win = Math.max(1000, num(rollingMs, COMPARE_ROLLING_MS) || COMPARE_ROLLING_MS);
    const startMs = Math.max(0, endMs - win);
    const list = Array.isArray(samples) ? samples : [];

    let bpmSum = 0;
    let bpmN = 0;
    let intSum = 0;
    let intN = 0;
    let lastBpm = null;
    let lastInt = null;

    for (const s of list) {
      const t = num(s && s.t);
      if (t == null || t0 == null) continue;
      const elapsed = t - t0;
      if (elapsed < startMs) continue;
      if (elapsed > endMs) break;
      const bpm = num(s.bpm);
      const pct = sampleIntensity(s, profile);
      if (bpm != null && bpm > 0) {
        bpmSum += bpm;
        bpmN += 1;
        lastBpm = bpm;
      }
      if (pct != null) {
        intSum += pct;
        intN += 1;
        lastInt = pct;
      }
    }

    return {
      bpm: bpmN ? Math.round(bpmSum / bpmN) : lastBpm,
      intensity: intN ? Math.round(intSum / intN) : lastInt,
      sampleCount: bpmN,
      windowMs: win,
      atMs: endMs
    };
  }

  /**
   * FrancoEffortIndex: media pesata in “punti sforzo” (scala ~punti %).
   * Input già in punti (es. +12 = più intenso di 12).
   */
  function francoEffortIndex(parts) {
    const d = parts && typeof parts === 'object' ? parts : {};
    const keys = ['intensity', 'bpm', 'zoneHigh', 'kcal'];
    let wSum = 0;
    let acc = 0;
    for (const k of keys) {
      const v = num(d[k]);
      if (v == null) continue;
      const w = FEI_WEIGHTS[k];
      wSum += w;
      acc += w * v;
    }
    if (wSum <= 0) return null;
    return round1(acc / wSum);
  }

  /**
   * Confronta due allenamenti allo stesso elapsed.
   * - Intensità/BPM: finestra rolling (live)
   * - Zona/kcal: sessione 0→t (rate kcal/min, non totale relativo)
   *
   * FEI ≈ punti %: positivo = più intenso del riferimento.
   */
  function compareEffort(nowSession, refSession, nowRolling, refRolling) {
    const nowS = nowSession || {};
    const refS = refSession || {};
    const nowR = nowRolling || {};
    const refR = refRolling || {};

    const intNow = num(nowR.intensity);
    const intRef = num(refR.intensity);
    const bpmNow = num(nowR.bpm);
    const bpmRef = num(refR.bpm);

    // Delta intensità in punti percentuali (es. 72 − 60 = +12)
    let intensityPp = null;
    if (intNow != null && intRef != null) {
      // Se entrambe ~0 (sotto FC riposo Karvonen), non usarle: non discriminano
      if (intNow >= 1 || intRef >= 1) intensityPp = intNow - intRef;
    }

    // Delta BPM assoluto + contributo FEI in % relativa (capped)
    const bpmAbs = bpmNow != null && bpmRef != null ? Math.round(bpmNow - bpmRef) : null;
    let bpmPp = null;
    if (bpmNow != null && bpmRef != null && bpmRef > 0) {
      bpmPp = clampNum(((bpmNow - bpmRef) / bpmRef) * 100, -40, 40);
    }

    const zNow = num(nowS.zoneHighShare);
    const zRef = num(refS.zoneHighShare);
    const zonePp = zNow != null && zRef != null ? round1((zNow - zRef) * 100) : null;

    const rateNow = num(nowS.kcalPerMin);
    const rateRef = num(refS.kcalPerMin);
    let kcalPp = null;
    if (rateNow != null && rateRef != null) {
      // Confronto su ritmo (kcal/min), capped — evita +600% su totali piccoli
      const rel = relativeDelta(rateNow, rateRef, 0.5);
      kcalPp = rel != null ? clampNum(rel * 100, -30, 30) : null;
    }

    const fei = francoEffortIndex({
      intensity: intensityPp,
      bpm: bpmPp,
      zoneHigh: zonePp,
      kcal: kcalPp
    });

    // Headline live: intensità se disponibile, altrimenti % BPM
    const headlinePp = intensityPp != null ? intensityPp : bpmPp;

    return {
      fei: fei,
      headlinePp: headlinePp != null ? round1(headlinePp) : null,
      deltas: {
        // Valori già in “punti display” (non frazioni 0–1)
        intensity: intensityPp != null ? round1(intensityPp) : null,
        bpm: bpmAbs,
        bpmPct: bpmPp != null ? round1(bpmPp) : null,
        zoneHigh: zonePp,
        kcal: kcalPp != null ? round1(kcalPp) : null
      },
      now: {
        rolling: nowR,
        session: nowS
      },
      ref: {
        rolling: refR,
        session: refS
      }
    };
  }

  /**
   * Confronto completo a un elapsedMs (rolling + sessione).
   */
  function compareAtElapsed(nowWorkout, refWorkout, nowParticipant, refParticipant, elapsedMs, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const rollingMs = num(options.rollingMs, COMPARE_ROLLING_MS) || COMPARE_ROLLING_MS;
    const compareMs = Math.max(0, num(elapsedMs, 0) || 0);
    const nowStarted = nowWorkout && nowWorkout.startedAt;
    const refStarted = refWorkout && refWorkout.startedAt;
    const nowDur = Math.max(
      0,
      (nowWorkout.endedAt || nowWorkout.startedAt || 0) - (nowWorkout.startedAt || 0)
    );
    const refDur = Math.max(
      0,
      (refWorkout.endedAt || refWorkout.startedAt || 0) - (refWorkout.startedAt || 0)
    );

    const nowRoll = rollingMetrics(
      nowParticipant && nowParticipant.samples,
      nowStarted,
      compareMs,
      rollingMs,
      { profile: options.profile }
    );
    const refRoll = rollingMetrics(
      refParticipant && refParticipant.samples,
      refStarted,
      compareMs,
      rollingMs,
      { profile: options.profile }
    );
    const nowSess = windowMetrics(nowParticipant && nowParticipant.samples, nowStarted, compareMs, {
      profile: options.profile,
      kcalSession: nowParticipant && nowParticipant.kcalSession,
      fullDurationMs: options.nowFullMs != null ? options.nowFullMs : nowDur || compareMs
    });
    const refSess = windowMetrics(refParticipant && refParticipant.samples, refStarted, compareMs, {
      profile: options.profile,
      kcalSession: refParticipant && refParticipant.kcalSession,
      fullDurationMs: refDur
    });
    return compareEffort(nowSess, refSess, nowRoll, refRoll);
  }

  /**
   * Trova il partecipante nel workout di riferimento (id, poi nome).
   */
  function matchReferenceParticipant(refWorkout, participantId, name) {
    const parts = (refWorkout && refWorkout.participants) || {};
    const id = String(participantId || '').trim();
    if (id && parts[id]) return parts[id];
    const values = Object.values(parts);
    if (id) {
      const byId = values.find((p) => p && String(p.id) === id);
      if (byId) return byId;
    }
    const n = String(name || '')
      .trim()
      .toLowerCase();
    if (!n) return null;
    return values.find((p) => String(p.name || '').trim().toLowerCase() === n) || null;
  }

  return {
    DEFAULT_MAX_HR: DEFAULT_MAX_HR,
    DEFAULT_REST_HR: DEFAULT_REST_HR,
    HIGH_ZONE_PCT: HIGH_ZONE_PCT,
    FEI_WEIGHTS: FEI_WEIGHTS,
    COMPARE_ROLLING_MS: COMPARE_ROLLING_MS,
    estimateMaxHr: estimateMaxHr,
    estimateRestingHr: estimateRestingHr,
    resolveMaxHr: resolveMaxHr,
    resolveRestHr: resolveRestHr,
    intensityPct: intensityPct,
    kcalPerMinute: kcalPerMinute,
    normalizeProfile: normalizeProfile,
    profileReadyForCalories: profileReadyForCalories,
    relativeDelta: relativeDelta,
    francoEffortIndex: francoEffortIndex,
    windowMetrics: windowMetrics,
    rollingMetrics: rollingMetrics,
    compareEffort: compareEffort,
    compareAtElapsed: compareAtElapsed,
    matchReferenceParticipant: matchReferenceParticipant
  };
});
