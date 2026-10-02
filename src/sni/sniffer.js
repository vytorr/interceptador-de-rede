'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Caminho do tshark. Tenta o local padrão do Wireshark; senão, confia no PATH.
const TSHARK_CANDIDATES = [
  'C:\\Program Files\\Wireshark\\tshark.exe',
  'C:\\Program Files (x86)\\Wireshark\\tshark.exe',
];
function tsharkPath() {
  for (const p of TSHARK_CANDIDATES) if (fs.existsSync(p)) return p;
  return 'tshark';
}

/**
 * Captura ClientHellos TLS numa interface e entrega o SNI (nome do site) de
 * cada conexão HTTPS, junto do IP de origem — o nome aparece em texto puro no
 * handshake, então é visível mesmo quando o DNS é criptografado (DoH/DoT).
 *
 * O tshark faz a extração pesada; aqui só lemos as linhas `ip|ipv6|sni`.
 */
class SNISniffer {
  /**
   * @param {string|number} iface  interface do tshark (índice de `tshark -D` ou nome)
   * @param {(ev: {srcIp: string, sni: string}) => void} onSNI
   * @param {(err: Error) => void} onError
   */
  constructor(iface, onSNI, onError) {
    this.iface = iface;
    this.onSNI = onSNI;
    this.onError = onError;
    this.process = null;
    this.buffer = '';
    this.stopped = false;
  }

  start() {
    const args = [
      '-i', String(this.iface),
      // HTTPS sobre TCP (TLS) e sobre UDP (QUIC / HTTP-3, usado por Google/YouTube).
      '-f', 'tcp port 443 or udp port 443',
      // Qualquer pacote que carregue um SNI — cobre o ClientHello do TLS clássico
      // e também o ClientHello dentro do QUIC Initial (o tshark o decifra sozinho).
      '-Y', 'tls.handshake.extensions_server_name',
      '-T', 'fields',
      '-e', 'ip.src',
      '-e', 'ipv6.src',
      '-e', 'tls.handshake.extensions_server_name',
      '-e', 'ip.dst',
      '-e', 'ipv6.dst',
      '-E', 'separator=|',
      '-E', 'occurrence=f', // primeira ocorrência de cada campo
      '-l', // saída linha a linha (não bufferiza)
    ];

    this.process = spawn(tsharkPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) this._handleLine(line);
    });

    let stderr = '';
    this.process.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    this.process.on('error', (err) => this.onError(new Error(`Falha ao iniciar o tshark: ${err.message}`)));
    this.process.on('exit', (code) => {
      if (this.stopped) return;
      this.onError(new Error(`tshark encerrou (código ${code}). ${stderr.trim().split('\n').pop() || ''}`));
    });
  }

  _handleLine(line) {
    if (!line.trim()) return;
    const [ip4, ip6, sni, dip4, dip6] = line.split('|').map((s) => s.trim());
    const srcIp = ip4 || ip6;
    if (!srcIp || !sni) return;
    const dstIp = dip4 || dip6 || null;
    this.onSNI({ srcIp, sni: sni.toLowerCase(), dstIp });
  }

  stop() {
    this.stopped = true;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    return Promise.resolve();
  }
}

module.exports = { SNISniffer, tsharkPath };
