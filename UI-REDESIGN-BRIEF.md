# HRcast — brief per redesign UI

Documento di handoff per chi rifà l’interfaccia grafica.

---

## Cos’è

App **LAN** per raccogliere il **battito cardiaco (BPM) in tempo reale** in sala (spinning / workout).

**Uso sperimentale / ricerca — non per uso clinico. Non promette accuratezza medica.**

Due ruoli:

1. **Coach** — dashboard su PC: QR di ingresso, griglia partecipanti live, avvio/stop allenamento
2. **Partecipante** — pagina mobile: nome + consenso → collega HR (HypeRate preferito, oppure BLE) → BPM grande a schermo

Testi UI in **italiano**.

---

## Stack tecnologico

| Layer | Tecnologia |
|--------|------------|
| Frontend | **HTML + CSS + JS vanilla** (niente React/Vue, niente bundler) |
| Backend | **Node.js + Express 4** (`server.js`) |
| Realtime | **Socket.IO 4** |
| HR esterno | **HypeRate** (`ws`, `lib/hyperate.js`) |
| Persistenza | **JSON su disco** (`data/workouts/`) — niente DB |
| Deploy tipico | HTTPS locale in LAN, porta **3033**, certificato self-signed |
| Dipendenze | `express`, `socket.io`, `ws`, `cors`, `qrcode`, `selfsigned` |
| Font | Google Fonts: **Bebas Neue**, **DM Sans** |
| CSS framework | **Nessuno** |

Avvio:

```bash
npm install
npm start
```

Equivalente a `node server.js`.

URL tipici:

```text
Coach:         https://localhost:3033/
Partecipante:  https://<IP-LAN>:3033/participant.html?room=spinning
Health:        https://localhost:3033/health
```

---

## Struttura cartelle

```text
workOutCast/
├── server.js              # HTTPS, REST, Socket.IO, serve static
├── package.json           # hrcast v2.0.0
├── README.md
├── lib/
│   ├── hyperate.js        # hub multi-WS HypeRate
│   └── workouts.js        # start/stop + storico JSON
├── public/                # ← TUTTA la UI attuale
│   ├── index.html         # dashboard coach
│   ├── participant.html   # flusso partecipante (mobile)
│   └── student.html       # redirect → participant.html
├── scripts/gen-certs.js
├── certs/                 # key.pem, cert.pem (gitignored)
├── data/workouts/         # sessioni JSON (gitignored)
├── ios-sender/            # legacy — fuori architettura
└── raspberry-scan/        # legacy — fuori architettura
```

---

## Dove toccare per la UI

Superficie di redesign = sostanzialmente **due file**:

| File | Ruolo |
|------|--------|
| `public/index.html` | Coach: brand, QR, barra REC workout, card griglia BPM |
| `public/participant.html` | Mobile: setup → sessione → HypeRate/BLE → BPM grande |
| `public/student.html` | Redirect sottile verso `participant.html` |

CSS e JS sono **inline** negli HTML. Nessuna cartella `assets/`, nessun design system formale, nessuna libreria componenti.

### Token / look (studio cycling — redesign mockup)

Definiti in `:root` su entrambe le pagine:

| Token | Valore tipico | Uso |
|-------|---------------|-----|
| bg | `#070b0a`–`#0e1613` | Sfondi performance |
| surface / card | `#121c18` / `#15211c` | Superfici |
| accent | `#ff4d3a` | Brand / REC / zona max |
| zone-green | `#2ee59d` | Zona bassa / ok (&lt;70%) |
| zone-blue | `#3db8ff` | Zona moderata (70–80%) |
| zone-orange | `#ff9a2e` | Zona alta (80–90%) |
| zone-red | `#ff4d3a` | Zona molto alta (≥90%) |
| text | `#f2f5f3` | Testo principale |
| muted | `#7d8f86` | Testo secondario |
| warn | `#f0c674` | Avvisi |

Intensità % = Karvonen `(bpm − FCriposo) / (FCmax − FCriposo)` se il partecipante ha compilato il profilo; altrimenti `% di FCmax` (default 185).

Calorie = Keytel et al. (kcal/min da FC, peso, età, sesso), accumulate in sessione.

Pattern UI:

- Coach = schermo sala: griglia card dense (nome, BPM enorme, %, zona colore, LIVE/offline/instabile) + barra live (partecipanti, media, max, durata)
- Partecipante = 3 step: Identificati → Connetti → Live (BPM enorme, stesso linguaggio zona)
- Bottoni `.primary` / `.secondary` / `.danger`
- Font: Bebas Neue (brand + BPM); DM Sans (body)
- Micro-motion: scala `.beat` su BPM/card; pallini LIVE/REC

---

## Architettura dati (HR)

### Percorso consigliato: HypeRate

```text
Apple Watch (HypeRate) ──► cloud HypeRate ──WS──► SERVER (1 WebSocket per allievo) ──► dashboard coach
                              ▲
Telefono: apre participant.html e inserisce il HypeRate ID (niente BLE)
```

Serve token API HypeRate **inserito dall’allievo in profilazione** (salvato in localStorage sul telefono). Test senza orologio: HypeRate ID `internal-testing` (BPM finti 60–80).

### Percorso alternativo: BLE

```text
SMARTWATCH / FASCIA ──BLE Heart Rate──► SMARTPHONE (browser) ──Wi‑Fi / HTTPS──► SERVER
```

| Piattaforma | Browser |
|-------------|---------|
| Android | **Chrome** (Web Bluetooth nativo) |
| iPhone | **Bluefy – Web BLE Browser** (Safari/Chrome iOS non supportano Web Bluetooth) |

HTTPS in LAN è obbligatorio per Web Bluetooth da IP.

---

## Flussi UX da preservare

### Coach

1. Apri dashboard
2. Mostra QR LAN (IP Wi‑Fi, non `localhost`)
3. Guarda card partecipanti con BPM live
4. Opzionale: **Avvia / Termina allenamento** (registra sample su disco in `data/workouts/`)

### Partecipante

1. Scan QR (dashboard coach) → apre la pagina
2. Nome / codice + **consenso** → Inizia
3. Collega orologio: HypeRate ID **oppure** popup Web Bluetooth
4. Conferma dispositivo se BLE (“Sei tu?” / Cambia)
5. BPM live a schermo + invio al server (Socket.IO, fallback `POST /api/bpm`)
6. Indicatori: Server · Orologio / HypeRate · Stream BPM
7. Wake Lock / avviso: non bloccare telefono né cambiare app durante la sessione

---

## Confronto allenamenti + FrancoEffortIndex (FEI)

Obiettivo prodotto: confrontare l’intensità di una lezione **in corso** (o appena terminata) con una lezione di **riferimento** dallo storico.

### Ruoli

| | Coach | Partecipante |
|---|---|---|
| Delta live | Tutti gli allievi + media classe | Solo sé stesso |
| Riepilogo finale | Confronto completo A vs B (classe + per persona) | Solo il proprio A vs B |

### Flusso

1. **Setup (coach)** — da **Lezioni**, scegli una lezione come riferimento (`Confronta`). La barra workout mostra `FEI vs <titolo>`. Senza riferimento → comportamento attuale.
2. **Avvia** — il `referenceWorkoutId` viene salvato sulla sessione. Allineamento sul tempo `t`. In compare mode il server programma **auto-stop** a fine durata riferimento (`stopReason: auto-compare`); i client ricevono `workout:status` e aprono il riepilogo.
3. **Live** — delta + **FrancoEffortIndex** su card coach e sullo schermo partecipante (barra: `fine tra mm:ss`).
4. **Termina** — manuale oppure automatico a fine riferimento → riepilogo duale.

Match allievo: prima per `participantId`, poi per nome (case-insensitive). Se assente nel riferimento → `—` (niente FEI individuale).

### Quattro indicatori + indice

| Indicatore | Live / finale |
|---|---|
| Intensità % (Karvonen) | media nella finestra `0→t` |
| BPM | media nella finestra |
| Zona alta | % tempo con intensità ≥ 80% (Z3+Z4) |
| Calorie | kcal accumulate (o stimate) nella finestra |
| **FrancoEffortIndex (FEI)** | aggregato pesato in punti sforzo (~punti %) |

### Formula FEI (v2)

Confronto allineato sul tempo `t` (troncato alla durata più corta):

- **Intensità / BPM** → media rolling ultimi **20s** a tempo `t` (delta live reale)
- **Zona alta / calorie** → accumulo `0→t`, calorie come **kcal/min** (non totale relativo)

```text
Δint  = Int_now − Int_ref          // punti % intensità (es. +12)
Δbpm  = (Bpm_now − Bpm_ref) / Bpm_ref × 100   // capped ±40
Δzone = (Zone_now − Zone_ref) × 100           // punti % tempo in Z3+Z4
Δkcal = (kcal/min_now − kcal/min_ref) / max(ref, 0.5) × 100   // capped ±30
```

Se entrambe le intensità sono ~0 (FC sotto riposo Karvonen), l’intensità viene ignorata e il segnale primario diventa il BPM.

Pesi:

| Peso | Indicatore |
|------|------------|
| 0.55 | Intensità (punti %) |
| 0.25 | BPM |
| 0.12 | Zona alta |
| 0.08 | kcal/min |

```text
FEI = 0.55·Δint + 0.25·Δbpm + 0.12·Δzone + 0.08·Δkcal
```

Indicatore mancante → pesi rimanenti rinormalizzati.  
`FEI > 0` = più intenso del riferimento. Headline live: `Δ` intensità in punti % (fallback % BPM).

Implementazione in `lib/metrics.js` (`compareAtElapsed`, `francoEffortIndex`). Snapshot live in `workout:status`.

### API / Socket (estensioni)

| Metodo / evento | Note |
|---|---|
| `POST /api/workout/start` | Body opzionale: `{ title?, referenceWorkoutId? }` — in compare abilita auto-stop |
| `GET /api/workout` / `workout:status` | Include `reference`, `compare`, `automation` (`autoStopAt`, `remainingMs`, `stopReason`) |
| Sessione JSON | `referenceWorkoutId`, `compareMode`, `referenceDurationMs`, `autoStopAt`, `stopReason` |

Policy riusabile (anche da job esterni): `buildCompareAutomation` / `durationOfWorkout` in `lib/workouts.js`.

Contratti esistenti restano validi; i nuovi campi sono additivi.

---

## Contratti API da non rompere

Il redesign può cambiare layout/CSS/copy visuale; gli eventi Socket.IO e le route REST vanno **lasciati stabili** (o adattati con compatibilità).

### Auth

Nessuna. API aperta in LAN. CORS `*`.

### REST (principali)

| Metodo | Path | Note |
|--------|------|------|
| GET | `/health` | Healthcheck |
| GET | `/api/info` | Info sessione / rete |
| GET | `/api/qr` | QR PNG/data (query `url`) |
| GET | `/api/participants` | Roster (alias `/api/students`) |
| GET | `/api/stream?since=` | Stream polling |
| POST | `/api/register` | Registrazione partecipante (+ `profile?`) |
| POST | `/api/profile` | Aggiorna profilo biometrico |
| POST | `/api/bpm` | Ingest BPM (fallback) |
| POST | `/api/ingest` | Ingest generico |
| POST | `/api/hyperate/subscribe` | Subscribe HypeRate |
| POST | `/api/hyperate/unsubscribe` | Unsubscribe HypeRate |
| GET | `/api/hyperate/status` | Stato HypeRate |
| GET/POST | `/api/workout` | Stato workout (+ `reference`, `compare` se FEI attivo) |
| POST | `/api/workout/start` | Avvia registrazione (`referenceWorkoutId?`) |
| POST | `/api/workout/stop` | Termina registrazione |
| GET | `/api/workouts` | Storico |
| GET | `/api/workouts/:id` | Dettaglio sessione |

Static: Express serve `public/` da `/`.

### Socket.IO

**Client → server**

- `participant:register`
- `participant:profile`
- `participant:bpm`
- `participant:hyperate`
- `participant:hyperate:stop`
- `workout:start` / `workout:stop`
- (legacy) `student:*`

**Server → client**

- `session-info`
- `lista-allievi`
- `battito-allievo`
- `workout:status`
- `hyperate:status`

Client Socket.IO caricato da `/socket.io/socket.io.js`.

---

## Variabili d’ambiente (solo nomi)

| Var | Default | Descrizione |
|-----|---------|-------------|
| `PORT` | `3033` | Porta |
| `ROOM` | `spinning` | Nome stanza |
| `HTTPS` | on | `HTTPS=false` solo per test localhost |
| `HYPERATE_WS_URL` | — | Override URL WS (opzionale) |
| `HYPERATE_ORIGIN` | — | Header Origin WS (opzionale) |

Il token API HypeRate **non** è più una variabile d’ambiente: lo inserisce ogni partecipante nel profilo.

`.env` è in `.gitignore`; non c’è `dotenv` nel `package.json` — le variabili si impostano nella shell.

Certificati: `certs/` (rigenera con `npm run certs` / `npm run certs:force`).

---

## Note per chi ridisegna

- Coach = **desktop**; partecipante = **mobile-first**
- Contesto: palestra / sala spinning — BPM leggibili da lontano
- Opzionale: estrarre CSS/JS in file separati (oggi tutto inline per semplicità)
- Ignorare per la UI: `ios-sender/`, `raspberry-scan/`, `scan-ble.js` (legacy)
- Non cambiare i contratti realtime/REST senza allineare `server.js` e entrambe le pagine
- Disclaimer sperimentale va mantenuto in copy o footer

---

## Riferimenti

- README principale: `README.md`
- Entry server: `server.js`
- UI coach: `public/index.html`
- UI partecipante: `public/participant.html`
- HypeRate hub: `lib/hyperate.js`
- Workout store: `lib/workouts.js`
- API HypeRate: https://www.hyperate.io/api.html
