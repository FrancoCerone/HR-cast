/**
 * Genera certificato TLS self-signed per HTTPS in LAN (Web Bluetooth richiede secure context).
 * Uso: node scripts/gen-certs.js
 */
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const os = require('os');

const certDir = path.join(__dirname, '..', 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

function localIps() {
  const ips = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function ensureCerts({ force = false } = {}) {
  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath, created: false };
  }

  fs.mkdirSync(certDir, { recursive: true });
  const ips = localIps();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip }))
  ];

  const attrs = [{ name: 'commonName', value: 'HRcast LAN' }];
  const pems = selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames
      }
    ]
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { keyPath, certPath, created: true, ips };
}

if (require.main === module) {
  const result = ensureCerts({ force: process.argv.includes('--force') });
  if (result.created) {
    console.log('[TLS] Certificato creato in certs/');
    console.log('[TLS] IP inclusi nel SAN:', (result.ips || []).join(', ') || 'nessuno');
    console.log('[TLS] Rigenera con --force dopo cambio rete/IP.');
  } else {
    console.log('[TLS] Certificato già presente in certs/ (usa --force per rigenerare)');
  }
}

module.exports = { ensureCerts, keyPath, certPath, certDir };
