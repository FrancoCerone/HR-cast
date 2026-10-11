/**
 * Diagnostica BLE: elenca 20 secondi di advertisement (nome, RSSI, servizi).
 * Uso: node scan-ble.js
 */
const noble = require('@abandonware/noble');

const DURATION_MS = 20000;
const seen = new Map();

function summarize(peripheral) {
  const adv = peripheral.advertisement || {};
  return {
    id: peripheral.id,
    name: adv.localName || '',
    rssi: peripheral.rssi,
    connectable: peripheral.connectable,
    services: adv.serviceUuids || [],
    manufacturer: adv.manufacturerData ? Buffer.from(adv.manufacturerData).toString('hex') : ''
  };
}

function printTable() {
  const rows = [...seen.values()].sort((a, b) => (b.rssi || -999) - (a.rssi || -999));
  console.log('\n=== Dispositivi BLE visti ===');
  for (const row of rows) {
    const mark = row.services.some((s) => String(s).toLowerCase().includes('180d')) ||
      /heartcast/i.test(row.name)
      ? ' << HEART RATE?'
      : '';
    console.log(
      `${String(row.rssi).padStart(4)}  ${(row.name || '(senza nome)').padEnd(22)}  ${row.id}  ` +
        `svc=[${row.services.join(',') || '-'}]${mark}`
    );
  }
  const hr = rows.filter(
    (r) => /heartcast/i.test(r.name) || r.services.some((s) => String(s).toLowerCase().includes('180d'))
  );
  console.log(
    hr.length
      ? `\nHeartCast/180d trovato: ${hr.length} dispositivo/i.`
      : '\nNessun HeartCast/180d. Windows non vede il broadcast Heart Rate (app in background o iOS non visibile a questo PC).'
  );
}

noble.on('stateChange', (state) => {
  console.log(`[BLE] stato: ${state}`);
  if (state !== 'poweredOn') return;
  console.log(`[BLE] scansione ${DURATION_MS / 1000}s senza filtri…`);
  noble.startScanning([], true);
  setTimeout(() => {
    noble.stopScanning();
    printTable();
    process.exit(0);
  }, DURATION_MS);
});

noble.on('discover', (peripheral) => {
  const row = summarize(peripheral);
  const prev = seen.get(peripheral.id);
  if (!prev || (row.name && !prev.name) || row.services.length > prev.services.length) {
    seen.set(peripheral.id, row);
    if (row.name || row.services.length) {
      console.log(
        `[visto] ${row.name || '(senza nome)'} rssi=${row.rssi} svc=[${row.services.join(',') || '-'}]`
      );
    }
  }
});
