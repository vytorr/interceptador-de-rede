'use strict';

const { execFileSync } = require('node:child_process');
const { SNISniffer, tsharkPath } = require('./sniffer');
const { ArpSpoofing } = require('./arp');

/**
 * Modo ARP: intercepta tráfego sem hotspot.
 *
 * 1. ARP spoofing (Python+scapy) desvia o tráfego do alvo para este PC.
 * 2. tshark captura o SNI na interface da LAN.
 * 3. O collector classifica, registra e alerta.
 *
 * O celular continua na rede normal (roteador); nada é configurado nele.
 */

function ps(command) {
  const full = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', full], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
}

/**
 * Descobre a interface da LAN (a que fala com o gateway) e seu índice no tshark.
 * Casa pelo GUID da placa, que é ASCII e aparece no device path do tshark.
 */
function lanInterfaceForGateway(gatewayIp) {
  // Prefixo /24 do gateway, ex.: "192.168.1." (usado como alternativa).
  const prefix = gatewayIp.split('.').slice(0, 3).join('.') + '.';
  let guid, alias, localIp;
  try {
    // 1ª tentativa: a interface da ROTA PADRÃO (a que vai à internet) — mais
    // confiável. 2ª tentativa: a placa com IP na sub-rede do gateway.
    const out = ps(
      `$r=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1;` +
        `$idx=$null; if($r){$idx=$r.ifIndex}` +
        `; if(-not $idx){$ipp=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '${prefix}*' } | Select-Object -First 1; if($ipp){$idx=$ipp.InterfaceIndex}}` +
        `; if($idx){$a=Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue;` +
        `$ip=(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $idx -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress;` +
        `"$($a.InterfaceGuid)|$($a.InterfaceAlias)|$ip"}`
    ).trim();
    if (!out || !out.includes('|')) return null;
    [guid, alias, localIp] = out.split('|').map((s) => s.trim());
    if (!guid) return null;
  } catch {
    return null;
  }

  // Encontra o índice no `tshark -D` cujo device path contém o GUID.
  let index = null;
  try {
    const dlist = execFileSync(tsharkPath(), ['-D'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const g = guid.toLowerCase();
    for (const line of dlist.split(/\r?\n/)) {
      const m = line.match(/^(\d+)\.\s+(\S+)/);
      if (m && m[2].toLowerCase().includes(g)) {
        index = Number(m[1]);
        break;
      }
    }
  } catch {
    return { error: 'sem-tshark' };
  }
  if (index == null) return { error: 'sem-interface' };
  return { index, alias: alias || 'LAN', localIp, guid };
}

/** Gateway IPv4 padrão (ex.: 192.168.1.1), ou null. */
function gateway4() {
  try {
    const out = ps(
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | " +
        'Sort-Object RouteMetric | Select-Object -First 1).NextHop'
    ).trim();
    if (!out || !/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

/** Gateway IPv6 padrão (link-local, ex.: fe80::1), ou null se não houver IPv6. */
function gateway6() {
  try {
    const out = ps(
      "(Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | " +
        'Sort-Object RouteMetric | Select-Object -First 1).NextHop'
    ).trim();
    // Ignora respostas vazias ou "::" (sem gateway v6 real).
    if (!out || out === '::' || !out.includes(':')) return null;
    return out;
  } catch {
    return null;
  }
}

class ArpMode {
  constructor(onSNI, onError) {
    this.onSNI = onSNI;
    this.onError = onError || (() => {});
    this.sniffer = null;
    this.spoofing = null;
    this.config = null;
    this.targets = new Map(); // ip -> mac (alvos confirmados)
  }

  /**
   * @param {string[]|'all'} victims - IPs dos celulares, ou 'all' para varrer
   * @param {string} gatewayIp - IP do roteador
   */
  async start(victims, gatewayIp) {
    try {
      if (!gatewayIp) throw new Error('Informe o IP do roteador (gateway)');
      if (!victims || (Array.isArray(victims) && victims.length === 0)) {
        throw new Error('Informe ao menos um IP de alvo, ou "all"');
      }

      // 1. Interface da LAN + índice do tshark.
      const lan = lanInterfaceForGateway(gatewayIp);
      if (!lan) throw new Error(`Não achei uma interface na sub-rede de ${gatewayIp}`);
      if (lan.error === 'sem-tshark') throw new Error('Wireshark/tshark não está instalado ou acessível');
      if (lan.error === 'sem-interface') throw new Error('tshark não listou a interface da LAN');

      this.config = { victims, gatewayIp, iface: lan.alias, localIp: lan.localIp };
      console.log(`[ARP] Interface da LAN: "${lan.alias}" (${lan.localIp}), índice tshark ${lan.index}`);

      // 2. Captura de SNI na interface da LAN.
      this.sniffer = new SNISniffer(
        lan.index,
        (ev) => this.onSNI(ev),
        (err) => this.onError(new Error(`[SNI] ${err.message}`))
      );
      this.sniffer.start();
      console.log(`[ARP] Captura de SNI iniciada em "${lan.alias}".`);

      // 3. ARP spoofing (IPv4) + NDP spoofing (IPv6, se houver) via Python+scapy.
      const gw6 = gateway6();
      if (gw6) {
        console.log(`[ARP] Gateway IPv6 detectado (${gw6}). Vou SUPRIMIR o IPv6 (forçar IPv4) para captura confiável.`);
      } else {
        console.log('[ARP] Sem gateway IPv6 — rede já é só IPv4.');
      }
      this.spoofing = new ArpSpoofing(
        gatewayIp,
        victims,
        (kind, parts) => this._onSpoofStatus(kind, parts),
        (err) => this.onError(new Error(`[ARP spoofing] ${err.message}`)),
        { gw6, iface: lan.alias }
      );
      if (!this.spoofing.start()) {
        throw new Error('Falha ao iniciar o ARP spoofing');
      }

      return true;
    } catch (err) {
      await this.stop();
      this.onError(err);
      return false;
    }
  }

  _onSpoofStatus(kind, parts) {
    if (kind === 'READY') {
      console.log(`[ARP] Gateway IPv4 resolvido (MAC ${parts[0]}). Spoofing ativo.`);
    } else if (kind === 'READY6') {
      console.log(`[ARP] IPv6 sendo suprimido (RA lifetime 0 via ${parts[0]}). Tráfego cairá no IPv4.`);
    } else if (kind === 'SPOOF') {
      const [ip, mac] = parts;
      this.targets.set(ip, mac);
      console.log(`[ARP] Interceptando ${ip} (${mac})`);
    } else if (kind === 'WARN') {
      console.log(`[ARP] ${parts.join(' ')}`);
    }
  }

  async stop() {
    if (this.sniffer) {
      await this.sniffer.stop();
      this.sniffer = null;
    }
    if (this.spoofing) {
      await this.spoofing.stop();
      this.spoofing = null;
    }
    console.log('[ARP] Modo ARP parado.');
  }
}

module.exports = { ArpMode, lanInterfaceForGateway, gateway4, gateway6 };
