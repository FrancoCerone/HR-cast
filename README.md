# HRcast

Raccolta battito cardiaco in tempo reale per esperimenti in sala.

**Uso sperimentale / ricerca — non per uso clinico. Non promette accuratezza medica.**

## Architettura

### Percorso consigliato: HypeRate (multi-client)

```
Apple Watch (HypeRate) ──► cloud HypeRate ──WS──► SERVER (1 WebSocket per allievo) ──► dashboard coach
                              ▲
Telefono: solo apre participant.html e inserisce il HypeRate ID (niente BLE / Bluefy)
```

Ogni allievo ha la **propria** WebSocket server→HypeRate (`hr:<ID>`). Il flusso verso la dashboard (`recordBpm` → `battito-allievo` / roster) resta uguale.

Serve una chiave API gratuita: [hyperate.io/api](https://www.hyperate.io/api.html) — ogni allievo la inserisce **nel profilo** (salvata sul telefono).

```bash
npm start
```

Test senza orologio: HypeRate ID `internal-testing` (BPM finti 60–80).

### Percorso alternativo: BLE (invariato)

```
┌─────────────────────┐     BLE Heart Rate      ┌──────────────────────┐     Wi‑Fi / HTTPS      ┌─────────────────┐
│  SMARTWATCH / FASCIA│ ──────────────────────► │  SMARTPHONE          │ ───────────────────► │  SERVER NOSTRO  │
│  (periferica BLE)   │   servizio 0x180D       │  (centrale BLE +     │  WebSocket o POST    │  pagina + ingest│
│                     │   char 0x2A37           │   gateway Wi‑Fi)     │                      │  NO BLE         │
└─────────────────────┘                         └──────────────────────┘                      └─────────────────┘
```

### App Watch ammesse (broadcast DAL Watch)

| Dispositivo | App / modalità |
|-------------|----------------|
| Apple Watch | **HeartBLE** o **Echo** (broadcast dal Watch) |
| Wear OS (Galaxy Watch 4+, Pixel, …) | **Heart for Bluetooth** (installata sul Watch) |
| Garmin | HR broadcasting nativo se disponibile |
| Fallback | Fascia petto BLE (Polar / Coospo / Magene) |

### App da non usare

- **HeartCast / Pulse Link** — trasmettono dall’iPhone (topologia sbagliata).
- Qualsiasi app che fa “broadcast” dal telefono invece che dal Watch.

### Browser telefono

| Piattaforma | Browser |
|-------------|---------|
| Android | **Chrome** (Web Bluetooth nativo) |
| iPhone | **Bluefy – Web BLE Browser** (Safari/Chrome iOS non supportano Web Bluetooth) |

Una sola codebase web: stessa pagina `participant.html` per iOS (Bluefy) e Android (Chrome). Nessuna app store nostra.

---

## Avvio rapido

```bash
npm install
npm start
```

Di default parte in **HTTPS** (certificato self-signed in `certs/`, generato al primo avvio).

```text
Coach:         https://localhost:3033/
Partecipante:  https://<IP-LAN>:3033/participant.html?room=spinning
Health:        https://localhost:3033/health
```

Variabili d’ambiente:

| Var | Default | Descrizione |
|-----|---------|-------------|
| `PORT` | `3033` | Porta |
| `ROOM` | `spinning` | Nome stanza |
| `HTTPS` | on | Imposta `HTTPS=false` solo per test localhost (Web Bluetooth da IP LAN richiede HTTPS) |

Rigenera il certificato dopo cambio IP/rete:

```bash
npm run certs:force
```

### HTTPS in LAN (obbligatorio per Web Bluetooth)

1. PC coach e telefoni sulla **stessa Wi‑Fi** (o hotspot del PC).
2. Avvia `npm start` → HTTPS su `0.0.0.0:3033`.
3. Sul telefono apri `https://<IP>:3033/participant.html` (o scansiona il QR sulla dashboard coach — il QR usa l’**IP LAN**, non `localhost`).
4. Accetta il certificato self-signed (avviso di sicurezza → Procedi / Avanzate).
5. **iPhone:** apri il link **dentro Bluefy**, non in Safari.
6. **Android:** apri in Chrome.

Se il certificato non coincide più con l’IP (hai cambiato rete), `npm run certs:force` e riaccetta sul telefono.

Se il coach apre la dashboard da `https://localhost:3033/`, il QR punta comunque all’IP Wi‑Fi del PC. Con più schede di rete, scegli l’IP giusto dal menu “Rete”.

---

## Flusso UX partecipante

1. **QR** (dashboard coach) → apre la pagina.
2. Nome / codice + **consenso** → Inizia.
3. **Collega orologio** → popup Web Bluetooth → scegli dispositivo Heart Rate.
4. Conferma **“Sei tu?”** (nome dispositivo) / **Cambia** se hai preso il sensore sbagliato.
5. **BPM live** sullo schermo + invio al server (Socket.IO, fallback `POST /api/bpm`).
6. Indicatori: Server · Orologio BLE · Stream BPM (riconnessione BLE automatica).

**Schermo / background:** mentre la sessione è attiva la pagina tenta Screen Wake Lock (se supportato) e ricorda di non bloccare il telefono né cambiare app — altrimenti lo stream si ferma.

---

## Checklist Watch / fascia

### Apple Watch
- [ ] Installa **HeartBLE** o **Echo** sul Watch (non sul solo iPhone).
- [ ] Avvia il broadcast Heart Rate **dal Watch**.
- [ ] iPhone: apri HRcast in **Bluefy**.
- [ ] Collega orologio → seleziona il dispositivo Heart Rate.

### Wear OS (Galaxy Watch 4+, Pixel Watch, …)
- [ ] Installa **Heart for Bluetooth** **sul Watch**.
- [ ] Avvia la trasmissione HR dal Watch.
- [ ] Telefono Android: Chrome → pagina → Collega orologio.

### Garmin
- [ ] Verifica se il modello supporta HR broadcasting Bluetooth standard.
- [ ] Attiva broadcast e collega dalla pagina web.

### Fallback fascia petto
- [ ] Polar H10 / Coospo / Magene (o altra fascia BLE HR standard).
- [ ] Accendi la fascia, indossala umida se richiesto.
- [ ] Dalla pagina: Collega orologio → seleziona la fascia.

---

## API server

### `GET /health`
Stato servizio.

### `POST /api/bpm` (o `/api/ingest`)
Fallback HTTP. Body esempio:

```json
{
  "participantId": "p-abc123",
  "bpm": 72,
  "t": 1710000000000,
  "source": "ble",
  "deviceName": "HeartBLE / Heart for Bluetooth / Polar H10",
  "name": "Marco",
  "quality": "good"
}
```

### `POST /api/register`
Registrazione senza BPM (fallback se WebSocket non è ancora su). Body: `{ participantId, name?, room? }`.

### WebSocket (Socket.IO) — preferito
- `participant:register` → `{ participantId, name, room }`
- `participant:bpm` → stesso payload dell’esempio sopra
- Eventi coach: `lista-allievi`, `battito-allievo`

### `GET /api/stream?since=<ms>`
Ultimi eventi BPM (log/ring buffer).

### `GET /api/info`
URL partecipante, IP LAN, stanza, modalità.

### Allenamento (storico su filesystem)

Dalla dashboard coach: **Avvia allenamento** / **Termina**. Durante la registrazione i BPM live vengono campionati (~1/s per allievo) e salvati in `data/workouts/`.

| Endpoint | Descrizione |
|----------|-------------|
| `GET /api/workout` | Stato corrente (`active`, summary) |
| `POST /api/workout/start` | Avvia. Body opzionale: `{ title }` |
| `POST /api/workout/stop` | Termina e flush su disco |
| `GET /api/workouts` | Elenco storico (senza serie complete) |
| `GET /api/workouts/:id` | Dettaglio con campioni BPM |

Socket.IO: `workout:start` / `workout:stop` (con ack) e broadcast `workout:status`.

File tipici:

```text
data/workouts/index.json
data/workouts/20261005-080215-a1b2.json
```

---

## Limiti noti

- **iOS Safari/Chrome:** niente Web Bluetooth → obbligatorio **Bluefy**.
- **HTTPS self-signed:** avviso certificato da accettare una volta per IP; su alcuni browser è scomodo.
- **Un telefono ↔ un Watch** per connessione GATT tipica; non scalare “N watch su un solo telefono” senza test dedicati.
- **Accuratezza:** dipende da Watch/fascia e app di terze parti; **non uso clinico**.
- **Distanza BLE:** telefono e Watch devono restare vicini.
- **Batteria / background:** tenere la pagina in primo piano; blocco schermo o cambio app ferma lo stream (documentato in UI).
- Cartelle legacy `raspberry-scan/`, `ios-sender/`, `scan-ble.js` non fanno parte di questa architettura (deprecate).

---

## Struttura

```text
server.js                 # HTTPS + ingest + dashboard stream
lib/hyperate.js           # hub multi-WS HypeRate
lib/workouts.js           # avvia/stop + storico JSON
scripts/gen-certs.js      # certificato LAN self-signed
data/workouts/            # sessioni salvate (gitignored)
public/
  index.html              # dashboard coach + QR + REC
  participant.html        # pagina unica: BLE / HypeRate
  student.html            # redirect → participant.html
```
