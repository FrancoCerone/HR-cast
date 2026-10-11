#!/usr/bin/env python3
"""
Scansione BLE su Raspberry Pi (BlueZ).
Cerca HeartCast / servizio Heart Rate (0x180D).

Uso:
  python3 scan_heartcast.py
  python3 scan_heartcast.py --seconds 30
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime

try:
    from bleak import BleakScanner
    from bleak.backends.device import BLEDevice
    from bleak.backends.scanner import AdvertisementData
except ImportError:
    print("Manca bleak. Installa con:")
    print("  pip3 install --user bleak")
    sys.exit(1)

HEART_RATE_UUIDS = {
    "0000180d-0000-1000-8000-00805f9b34fb",
    "180d",
}


def normalize_uuid(u: str) -> str:
    return str(u).lower().replace("-", "")


def is_heart_rate_uuid(u: str) -> bool:
    n = normalize_uuid(u)
    return n.endswith("180d") or n == "180d"


def looks_like_heartcast(name: str | None, service_uuids: list[str]) -> bool:
    n = (name or "").lower()
    if "heartcast" in n or "heart cast" in n:
        return True
    if "heart" in n and "rate" in n:
        return True
    return any(is_heart_rate_uuid(u) for u in service_uuids)


def fmt_uuids(uuids: list[str]) -> str:
    if not uuids:
        return "-"
    short = []
    for u in uuids:
        nu = normalize_uuid(u)
        if len(nu) >= 8 and nu.endswith("180d"):
            short.append("180d")
        elif len(nu) == 4:
            short.append(nu)
        else:
            short.append(u[-12:] if len(u) > 12 else u)
    return ",".join(short)


async def run_scan(seconds: int) -> int:
    print("=" * 60)
    print("WorkOutCast — scan BLE HeartCast / 180d")
    print(f"Durata: {seconds}s | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    print("Apri HeartCast sull'iPhone (schermo acceso) e premi Start sull'Watch.")
    print("Scansione in corso...\n")

    seen: dict[str, dict] = {}
    hits: list[str] = []

    def on_detect(device: BLEDevice, adv: AdvertisementData) -> None:
        name = device.name or adv.local_name
        uuids = list(adv.service_uuids or [])
        addr = device.address
        rssi = adv.rssi

        row = {
            "name": name or "",
            "rssi": rssi,
            "uuids": uuids,
            "addr": addr,
        }
        prev = seen.get(addr)
        if (
            not prev
            or (name and not prev["name"])
            or len(uuids) > len(prev["uuids"])
            or (rssi is not None and (prev["rssi"] is None or rssi > prev["rssi"]))
        ):
            seen[addr] = row
            mark = ""
            if looks_like_heartcast(name, uuids):
                mark = "  <<< HEART RATE / HEARTCAST?"
                if addr not in hits:
                    hits.append(addr)
                    print(
                        f"[HIT] {name or '(senza nome)'}  {addr}  "
                        f"rssi={rssi}  svc=[{fmt_uuids(uuids)}]{mark}"
                    )
            elif name or uuids:
                print(
                    f"[visto] {name or '(senza nome)'}  {addr}  "
                    f"rssi={rssi}  svc=[{fmt_uuids(uuids)}]"
                )

    scanner = BleakScanner(detection_callback=on_detect)
    await scanner.start()
    try:
        await asyncio.sleep(seconds)
    finally:
        await scanner.stop()

    print("\n" + "=" * 60)
    print(f"Dispositivi unici visti: {len(seen)}")
    print("-" * 60)

    rows = sorted(seen.values(), key=lambda r: (r["rssi"] is None, -(r["rssi"] or -999)))
    for r in rows:
        flag = " *" if looks_like_heartcast(r["name"], r["uuids"]) else ""
        print(
            f"  rssi={str(r['rssi']).rjust(4)}  "
            f"{(r['name'] or '(senza nome)'):22s}  {r['addr']}  "
            f"svc=[{fmt_uuids(r['uuids'])}]{flag}"
        )

    print("-" * 60)
    if hits:
        print(f"RISULTATO: OK — possibili HeartCast/180d: {len(hits)}")
        print("La Raspberry vede il segnale. Si può fare il bridge verso il PC.")
        return 0

    print("RISULTATO: NESSUN HeartCast / 180d trovato.")
    print("Controlla: HeartCast in primo piano, Start sull'Watch, dongle BT USB inserito.")
    if not seen:
        print("Nessun dispositivo BLE: manca dongle Bluetooth o driver BlueZ.")
    return 1


def main() -> None:
    p = argparse.ArgumentParser(description="Scan BLE per HeartCast / Heart Rate 180d")
    p.add_argument("--seconds", "-s", type=int, default=25, help="Durata scansione (default 25)")
    args = p.parse_args()
    try:
        code = asyncio.run(run_scan(max(5, args.seconds)))
    except Exception as exc:  # noqa: BLE001
        print(f"Errore scansione: {exc}")
        print("Su Raspberry: sudo apt install bluetooth bluez")
        print("Verifica adattatore: hciconfig  oppure  bluetoothctl show")
        sys.exit(2)
    sys.exit(code)


if __name__ == "__main__":
    main()
