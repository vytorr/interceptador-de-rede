'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');

/** Endereços IPv4 deste computador na rede local (é o que vai no DNS do celular). */
function localAddresses() {
  const result = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        result.push({ interface: iface, address: a.address });
      }
    }
  }
  return result;
}

/** Extrai pares IP -> MAC da saída de `arp -a` (Windows ou Unix). */
function parseArp(output) {
  const map = new Map();
  const re = /(\d{1,3}(?:\.\d{1,3}){3})\D+?([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i;
  for (const line of output.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) {
      const mac = m[2].toLowerCase().replace(/-/g, ':');
      if (mac !== 'ff:ff:ff:ff:ff:ff' && !mac.startsWith('01:00:5e')) map.set(m[1], mac);
    }
  }
  return map;
}

function readArpTable() {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? new Map() : parseArp(stdout));
    });
  });
}

/** Atualiza periodicamente o MAC dos aparelhos conhecidos, para ajudar a identificá-los. */
function startArpRefresh(store, intervalMs = 120_000) {
  const refresh = async () => {
    const table = await readArpTable();
    for (const d of store.devices()) {
      const mac = table.get(d.ip);
      if (mac) store.setDeviceMac(d.ip, mac);
    }
  };
  refresh();
  return setInterval(refresh, intervalMs).unref();
}

module.exports = { localAddresses, parseArp, startArpRefresh };
