# HRcast Sender (iPhone)

App iOS minima: legge i BPM da Apple Watch (via HealthKit) e li invia al server del coach via Wi‑Fi.

## Requisiti

- Mac con Xcode 15+
- Apple Developer account (per installare sui telefoni degli allievi: TestFlight o Ad Hoc)
- iPhone + Apple Watch dell'allievo
- Permessi Salute: Frequenza cardiaca + Allenamenti

## Configurazione server

Il coach avvia il server e condivide l'URL LAN, es.:

```
http://192.168.1.10:3033
```

Ogni allievo inserisce nome + questo indirizzo in `student.html`, oppure lo configura nell'app nativa.

## API usata dall'app

```
POST http://IP_COACH:3033/api/bpm
Content-Type: application/json

{
  "studentId": "s-abc123",
  "name": "Marco",
  "bpm": 128,
  "source": "ios-app"
}
```

## Build (su Mac)

1. Apri `WorkOutCastSender.xcodeproj` in Xcode (da creare importando i file Swift; brand: HRcast).
2. Imposta il **Team** di signing.
3. In `Config.swift` imposta `defaultServerURL` con l'IP del coach.
4. Run su iPhone fisico (HealthKit non funziona sul simulatore Watch reale).

## Alternativa senza app Store

Distribuisci via **TestFlight** agli allievi, oppure usa temporaneamente `student.html` con invio manuale BPM per testare la dashboard coach.

## Note HeartCast

HeartCast **non** espone API verso un server custom. Questa app sostituisce HeartCast per l'invio al PC del coach.
