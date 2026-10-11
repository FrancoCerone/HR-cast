# Scan HeartCast su Raspberry Pi 2

Script di test: la Pi riesce a vedere HeartCast / servizio Heart Rate (`180d`)?

## Requisiti hardware

- Raspberry Pi 2 (non ha Bluetooth integrato)
- **Dongle USB Bluetooth** (es. TP-Link UB500) — obbligatorio
- Ethernet (o Wi‑Fi USB) verso la rete
- iPhone con HeartCast + Apple Watch

## Setup (una volta sola)

Sulla Raspberry, da terminale:

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv bluetooth bluez

# Copia questa cartella sulla Pi, poi:
cd raspberry-scan
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Inserisci il dongle Bluetooth USB, poi:

```bash
# Verifica che BlueZ veda l'adapter
hciconfig
# oppure
bluetoothctl show
```

Se non compare nessun adapter, il dongle non è riconosciuto.

## Test con HeartCast

1. Apri **HeartCast** sull’iPhone (schermo acceso).
2. Premi **Start** sull’Apple Watch e verifica i BPM sull’iPhone.
3. Sulla Pi:

```bash
cd raspberry-scan
source .venv/bin/activate
python3 scan_heartcast.py
```

Scansione più lunga (40 secondi):

```bash
python3 scan_heartcast.py --seconds 40
```

## Come leggere il risultato

- Riga `[HIT] ... <<< HEART RATE / HEARTCAST?` → **la Pi vede il segnale**
- In fondo `RISULTATO: OK` → si può fare il bridge verso il PC coach
- `RISULTATO: NESSUN HeartCast / 180d` → anche la Pi non lo vede (o HeartCast non sta trasmettendo)
- `Dispositivi unici visti: 0` → manca/non funziona il dongle BT

## Copiare i file dal PC Windows

Dalla cartella del progetto sul PC (PowerShell), esempio con scp:

```powershell
scp -r C:\D_E_V_E_L_O_P\gitHubFrancoPowerSpinning\workOutCast\raspberry-scan pi@IP_DELLA_PI:~/
```

(sostituisci `pi` e `IP_DELLA_PI` con utente e IP reali)
