"""
Vigia de restauração do ARP (rede à prova de falhas).

Este processo roda DESACOPLADO do console da janela do Monitor: sem console
próprio e fora do grupo de processos da janela do PowerShell. Por isso ele
SOBREVIVE quando a janela é fechada, quando o processo pai é morto no
Gerenciador de Tarefas ou quando ele simplesmente trava.

Função única e crítica: vigiar o processo de ARP spoofing (pelo PID). No
instante em que ele morrer — por qualquer motivo — o vigia devolve às tabelas
ARP do(s) celular(es) e do roteador o MAC real do gateway, repetidas vezes,
para que a internet do celular NUNCA fique caída depois de encerrar o Monitor.

Uso (chamado automaticamente pelo arp_spoof.py):
    python arp_watchdog.py --ppid 1234 --gateway 192.168.1.1 \
        --gateway-mac aa:bb:.. --victims "192.168.1.50=11:22:..;192.168.1.51=33:.." \
        [--iface Wi-Fi]
"""
import argparse
import os
import sys
import threading
import time

import logging
logging.getLogger("scapy.runtime").setLevel(logging.ERROR)

from scapy.all import (  # noqa: E402
    ARP, Ether, send, sendp, conf, get_if_hwaddr, IPv6, ICMPv6ND_RA, ICMPv6ND_RS,
)

ALL_NODES_IP6 = "ff02::1"
ALL_NODES_MAC = "33:33:00:00:00:01"
ALL_ROUTERS_IP6 = "ff02::2"
ALL_ROUTERS_MAC = "33:33:00:00:00:02"


def restore(target_ip, target_mac, source_ip, source_mac, count=5):
    """
    Corrige a tabela ARP do alvo para "source_ip está no source_mac".

    Definimos Ether.src = NOSSO MAC explicitamente (sem isso o sendp manda origem
    00:00:00:00:00:00, malformado, que o celular descarta — era o bug). O Android
    atualiza a tabela pelo conteúdo do ARP. A forma mais forte é o REQUEST (op=1),
    que OBRIGA o alvo a gravar source_ip->source_mac.
    """
    try:
        my_mac = get_if_hwaddr(conf.iface)
    except Exception:  # noqa: BLE001
        my_mac = None

    def eth(dst):
        return Ether(src=my_mac, dst=dst) if my_mac else Ether(dst=dst)

    # Só unicast direto ao celular (sem broadcast gratuito, que é o que mais
    # dispara o detector de ARP spoofing do celular).
    frames = [
        eth(target_mac) / ARP(op=1, pdst=target_ip, hwdst=target_mac,
                              psrc=source_ip, hwsrc=source_mac),
        eth(target_mac) / ARP(op=2, pdst=target_ip, hwdst=target_mac,
                              psrc=source_ip, hwsrc=source_mac),
    ]
    for f in frames:
        try:
            sendp(f, count=count, verbose=False)
        except Exception:  # noqa: BLE001
            pass


def ra_restore(router_ll, our_mac):
    """Reativa o IPv6 de forma SEGURA: só um Router Solicitation (origem "::"),
    que OBRIGA o roteador real a reenviar seu RA verdadeiro em multicast. NÃO
    forja RA (RA forjado faz o Android reconfigurar e derrubar até o IPv4)."""
    if not our_mac:
        return
    try:
        sendp(
            Ether(src=our_mac, dst=ALL_ROUTERS_MAC)
            / IPv6(src="::", dst=ALL_ROUTERS_IP6, hlim=255)
            / ICMPv6ND_RS(),
            count=3, verbose=False,
        )
    except Exception:  # noqa: BLE001
        pass


def forward_grace(stop_evt):
    """
    Mantém o tráfego do celular sendo ENCAMINHADO por este PC durante a transição,
    para a internet do celular NÃO cair ao fechar o monitor.

    Durante o monitoramento, quem encaminha o tráfego do celular é o WinDivert
    (camada NETWORK_FORWARD) — o kernel do Windows não faz isso de forma confiável.
    Quando o monitor fecha, esse encaminhamento some e o celular (que ainda aponta
    para o PC) fica órfão até reaprender o gateway. Aqui o vigia assume o
    encaminhamento por um tempo: como paramos de envenenar, a entrada ARP do
    celular "envelhece" e ele volta a falar direto com o roteador — e, enquanto
    isso não acontece, o PC segue encaminhando, então o celular nunca sente corte.
    """
    try:
        from pydivert import WinDivert, Layer
    except Exception:  # noqa: BLE001
        return
    # Mesmo filtro do blocker: o sentido de subida do celular (443 TCP e QUIC).
    flt = "tcp.DstPort == 443 or udp.DstPort == 443"
    try:
        w = WinDivert(flt, layer=Layer.NETWORK_FORWARD)
        w.open()
    except Exception:  # noqa: BLE001
        return
    # Fecha o handle quando for hora de parar -> destrava o recv e sai.
    threading.Thread(target=lambda: (stop_evt.wait(), _safe_close(w)), daemon=True).start()
    try:
        for packet in w:
            try:
                w.send(packet)  # reinjeta: deixa o tráfego seguir ao gateway real
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass  # handle fechado = fim normal


def _safe_close(w):
    try:
        w.close()
    except Exception:  # noqa: BLE001
        pass


def wait_for_parent_exit(ppid):
    """Bloqueia até o processo pai (o arp_spoof) terminar. À prova de falhas."""
    if sys.platform == "win32":
        import ctypes
        SYNCHRONIZE = 0x00100000
        INFINITE = 0xFFFFFFFF
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(SYNCHRONIZE, False, int(ppid))
        if handle:
            try:
                k32.WaitForSingleObject(handle, INFINITE)
            finally:
                k32.CloseHandle(handle)
            return
    # Fallback (ou pai já morto): poll simples.
    while _pid_alive(ppid):
        time.sleep(0.5)


def _pid_alive(pid):
    if sys.platform == "win32":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ppid", required=True)
    ap.add_argument("--gateway", required=True)
    ap.add_argument("--gateway-mac", dest="gateway_mac", required=True)
    ap.add_argument("--victims", required=True, help="ip=mac;ip=mac;...")
    ap.add_argument("--iface", default=None)
    ap.add_argument("--gw6", default=None, help="gateway IPv6 (ex.: fe80::1) para reativar o IPv6")
    ap.add_argument("--our-mac", dest="our_mac", default=None, help="MAC desta placa (origem L2 do RA)")
    ap.add_argument("--duration", type=float, default=60.0, help="segundos encaminhando/restaurando após a morte do pai")
    args = ap.parse_args()

    if args.iface:
        try:
            conf.iface = args.iface
        except Exception:  # noqa: BLE001
            pass

    gateway_ip = args.gateway
    gateway_mac = args.gateway_mac
    victims = {}
    for part in args.victims.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        ip, mac = part.split("=", 1)
        victims[ip.strip()] = mac.strip()

    if not victims:
        return

    # 1. Espera o processo de ARP spoofing terminar (por qualquer motivo).
    wait_for_parent_exit(args.ppid)

    # 2. ENCAMINHAMENTO DE GRAÇA: mantém o tráfego do celular fluindo por este PC
    #    durante toda a transição. Como paramos de envenenar, a entrada ARP do
    #    celular envelhece e ele volta a falar direto com o roteador — e, enquanto
    #    isso não acontece, o PC segue encaminhando, então a internet NÃO cai.
    stop_evt = threading.Event()
    fwd = threading.Thread(target=forward_grace, args=(stop_evt,), daemon=True)
    fwd.start()

    # 3. Em paralelo, "cutuca" o celular a reaprender o gateway real (unicast),
    #    e reativa o IPv6. Se o celular aceitar, a transição é imediata; se não,
    #    ele reaprende sozinho ao envelhecer a entrada — sem corte, pois estamos
    #    encaminhando.
    deadline = time.time() + args.duration
    while time.time() < deadline:
        for ip, mac in victims.items():
            restore(ip, mac, gateway_ip, gateway_mac, count=2)
        ra_restore(args.gw6, args.our_mac)
        time.sleep(1.0)

    # 4. Fim da janela: para o encaminhamento. A esta altura o celular já deve
    #    estar falando direto com o roteador.
    stop_evt.set()
    fwd.join(timeout=3)


if __name__ == "__main__":
    main()
