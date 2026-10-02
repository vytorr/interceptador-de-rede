"""
Motor de bloqueio do Monitor de Rede (WinDivert / pydivert).

Intercepta, na camada de ENCAMINHAMENTO, apenas o sentido celular->servidor
na porta 443 (TCP e UDP/QUIC). Quando o SNI (nome do site) casa com a lista de
bloqueio, descarta o pacote -> o handshake nunca completa -> o site nao abre.

- TCP/TLS: le o SNI do ClientHello na hora e descarta se bloqueado.
- QUIC (UDP 443): o SNI vem cifrado; o Node (que usa o tshark) avisa os IPs de
  destino a bloquear via stdin, e aqui descartamos o QUIC para esses IPs.

Como so interceptamos o sentido de subida (DstPort 443), o trafego de descida
(downloads, video) nao passa por aqui -> sem perda de desempenho.

Protocolo stdin (uma linha JSON por atualizacao):
    {"keywords": ["porn","bet"], "sites": ["site.com"], "ips": ["1.2.3.4"]}

Saida (stdout), consumida pelo Node:
    READY
    BLOCK|<sni>          (TCP cortado pelo SNI)
    BLOCKQUIC|<ip>       (QUIC cortado por IP)
    ERROR|<msg>
"""
import sys
import os
import json
import time
import threading

try:
    from pydivert import WinDivert, Layer
except Exception as e:  # noqa: BLE001
    print("ERROR|pydivert indisponivel: " + str(e), flush=True)
    sys.exit(1)


def log(kind, *parts):
    print(kind + "|" + "|".join(str(p) for p in parts), flush=True)


class Rules:
    def __init__(self):
        self.lock = threading.Lock()
        self.keywords = []        # substrings (minusculas)
        self.sites = []           # dominios exatos (minusculas)
        self.ips_from_node = set()  # IPs de destino a bloquear (QUIC), vindos do Node
        self.ips_learned = set()    # IPs aprendidos ao cortar um SNI por TCP

    def update(self, data):
        with self.lock:
            if isinstance(data.get("keywords"), list):
                self.keywords = [str(k).lower() for k in data["keywords"] if k]
            if isinstance(data.get("sites"), list):
                self.sites = [str(s).lower() for s in data["sites"] if s]
            if isinstance(data.get("ips"), list):
                self.ips_from_node = {str(i) for i in data["ips"] if i}

    def sni_blocked(self, sni):
        with self.lock:
            for k in self.keywords:
                if k in sni:
                    return True
            for s in self.sites:
                if sni == s or sni.endswith("." + s):
                    return True
        return False

    def ip_blocked(self, ip):
        with self.lock:
            return ip in self.ips_from_node or ip in self.ips_learned

    def learn_ip(self, ip):
        with self.lock:
            self.ips_learned.add(ip)


def parse_sni(payload):
    """Extrai o SNI de um ClientHello TLS. None se nao for ClientHello/sem SNI."""
    try:
        b = payload
        n = len(b)
        if n < 6 or b[0] != 0x16 or b[5] != 0x01:
            return None  # nao e handshake(22) / ClientHello(1)
        pos = 9              # pula record(5) + handshake type(1) + length(3)
        pos += 2 + 32        # versao(2) + random(32)
        if pos >= n:
            return None
        sid_len = b[pos]; pos += 1 + sid_len          # session id
        if pos + 2 > n:
            return None
        cs_len = (b[pos] << 8) | b[pos + 1]; pos += 2 + cs_len  # cipher suites
        if pos >= n:
            return None
        comp_len = b[pos]; pos += 1 + comp_len        # compression methods
        if pos + 2 > n:
            return None
        ext_total = (b[pos] << 8) | b[pos + 1]; pos += 2
        end = min(n, pos + ext_total)
        while pos + 4 <= end:
            etype = (b[pos] << 8) | b[pos + 1]
            elen = (b[pos + 2] << 8) | b[pos + 3]
            pos += 4
            if etype == 0x0000:  # server_name
                # server_name_list(2) + type(1) + name_len(2) + name
                if pos + 5 > n:
                    return None
                name_len = (b[pos + 3] << 8) | b[pos + 4]
                start = pos + 5
                if start + name_len > n:
                    return None
                return bytes(b[start:start + name_len]).decode("ascii", "ignore").lower()
            pos += elen
    except Exception:  # noqa: BLE001
        return None
    return None


def stdin_reader(rules):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            rules.update(json.loads(line))
        except Exception as e:  # noqa: BLE001
            log("ERROR", "stdin: " + str(e))


def main():
    rules = Rules()
    t = threading.Thread(target=stdin_reader, args=(rules,), daemon=True)
    t.start()

    layer_name = "NETWORK_FORWARD"
    flt = "tcp.DstPort == 443 or udp.DstPort == 443"
    # Permite trocar de camada por variavel de ambiente, para diagnostico.
    if os.environ.get("BLOCKER_LAYER") == "NETWORK":
        layer_name = "NETWORK"

    try:
        layer = Layer.NETWORK if layer_name == "NETWORK" else Layer.NETWORK_FORWARD
        w = WinDivert(flt, layer=layer)
        w.open()
    except Exception as e:  # noqa: BLE001
        log("ERROR", "nao consegui abrir o WinDivert (admin?): " + str(e))
        sys.exit(1)

    log("READY", layer_name)

    stats = {"seen": 0, "tcp": 0, "udp": 0, "ch": 0, "sni": 0, "blocked": 0}
    last_report = [time.time()]

    def maybe_report():
        now = time.time()
        if now - last_report[0] >= 5:
            with rules.lock:
                nk, ns, ni = len(rules.keywords), len(rules.sites), len(rules.ips_from_node) + len(rules.ips_learned)
            log("STATS", f"seen={stats['seen']}", f"tcp={stats['tcp']}", f"udp={stats['udp']}",
                f"clienthello={stats['ch']}", f"sni_lidos={stats['sni']}", f"bloqueados={stats['blocked']}",
                f"regras=kw{nk},sites{ns},ips{ni}")
            last_report[0] = now

    try:
        for packet in w:
            try:
                stats["seen"] += 1
                if packet.tcp is not None:
                    stats["tcp"] += 1
                    if rules.ip_blocked(packet.dst_addr):
                        stats["blocked"] += 1
                        maybe_report()
                        continue
                    if packet.payload:
                        pl = packet.payload
                        if len(pl) >= 6 and pl[0] == 0x16 and pl[5] == 0x01:
                            stats["ch"] += 1
                        sni = parse_sni(pl)
                        if sni:
                            stats["sni"] += 1
                            if rules.sni_blocked(sni):
                                rules.learn_ip(packet.dst_addr)
                                stats["blocked"] += 1
                                log("BLOCK", sni)
                                maybe_report()
                                continue
                    w.send(packet)
                elif packet.udp is not None:
                    stats["udp"] += 1
                    if rules.ip_blocked(packet.dst_addr):
                        stats["blocked"] += 1
                        maybe_report()
                        continue
                    w.send(packet)
                else:
                    w.send(packet)
                maybe_report()
            except Exception:  # noqa: BLE001
                try:
                    w.send(packet)
                except Exception:  # noqa: BLE001
                    pass
    finally:
        try:
            w.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
