# Monitor/Interceptador de Rede

Monitor de rede local para Windows, voltado a **controle parental na própria
rede de casa**. Num painel web, mostra quais **sites e aplicativos** os aparelhos
da casa acessam, destaca conteúdo adulto/apostas/arriscado, bloqueia o que a
responsável escolher e barra anúncios. **Nada precisa ser instalado ou
configurado nos celulares.**

> **Uso legítimo.** Esta é uma ferramenta de interceptação de rede (MITM). Use
> apenas na **sua própria rede** e em dispositivos próprios ou sob sua
> responsabilidade (ex.: controle parental dos filhos menores), respeitando a
> legislação aplicável.

## Como funciona

O computador se coloca no caminho do tráfego da rede local e lê o **SNI** — o
nome do site, que aparece em texto puro no início de cada conexão HTTPS (o
*ClientHello* do TLS e do QUIC). Assim funciona mesmo com **DNS criptografado
(DoH/DoT)**, que contorna monitores baseados só em DNS.

```
Celular ──► PC (intercepta via ARP) ──► Roteador ──► Internet
            │ tshark lê o SNI (nome do site) de TCP 443 e QUIC/UDP 443
            │ classifica, registra e alerta
            └ WinDivert descarta a conexão se for site/anúncio bloqueado
```

- **IPv4:** ARP spoofing (o PC se anuncia como gateway). `scapy` (Python).
- **IPv6:** como o NDP é instável, o monitor **suprime o IPv6** (Router
  Advertisement com *lifetime* 0), forçando os aparelhos a usar IPv4 — que é
  interceptado de forma confiável. Reversível ao encerrar.
- **Captura:** `tshark` (Wireshark + Npcap) extrai o SNI de TCP **e** QUIC.
- **Bloqueio:** `WinDivert` (`pydivert`) descarta o handshake quando o SNI casa
  com palavra/site bloqueado (e por IP de destino, para cobrir QUIC).
- **DNS** roda como complemento (registro e bloqueio para quem usa DNS comum).

**Não enxerga:** o conteúdo das páginas (só o nome do site), buscas ou qual vídeo
foi assistido; e não cobre **dados móveis (4G/5G)** nem outras redes Wi-Fi.
**Tetos conhecidos:** sites com **ECH** (SNI criptografado) e reuso de conexão
podem escapar; o ARP por Wi-Fi é menos estável que por cabo.

## Instalação (uso final)

1. Extraia a pasta do programa (se veio em `.zip`).
2. Dê dois cliques em **`INSTALAR.bat`** e autorize (SIM). Ele instala sozinho
   tudo que falta — Node.js, Wireshark/Npcap, Python, `scapy`, `pydivert` —
   libera o firewall, cria o atalho **"Monitor de Rede"** na Área de Trabalho e,
   no final, **confere se está tudo pronto**.
3. Para usar, dê dois cliques no atalho **"Monitor de Rede"** e autorize. O
   painel abre em `http://127.0.0.1:8484`. Deixe a janela aberta; para encerrar,
   feche-a (isso restaura a rede com segurança).

Veja [LEIA-ME.txt](LEIA-ME.txt) para o passo a passo da responsável.

> No primeiro clique o Windows pode mostrar "O Windows protegeu o seu
> computador" → **Mais informações → Executar assim mesmo**. O Npcap, se pedir
> confirmação, abre uma telinha: *I Agree → Install → Finish*.

## Recursos

- **Captura por SNI** (TCP + QUIC), por aparelho, mesmo com DNS criptografado.
- **Alertas** para conteúdo adulto, apostas e sites arriscados.
- **Bloqueio efetivo** por palavra, por site e **de anúncios** (redes de ads),
  via WinDivert — cobre TCP e QUIC.
- **Bloqueio automático** de categorias de alerta (ligado por padrão).
- **Painel web** com visão geral, registro ao vivo **paginado** (busca no
  servidor), aparelhos, bloqueios e configurações; tema claro/escuro.
- Mantém o PC acordado enquanto roda (para o celular não ficar sem internet).

## Rodar em desenvolvimento

Requer **Node.js 22.13+** (usa `node:sqlite` embutido; sem dependências npm de
execução) e, para a captura/bloqueio, **Wireshark/tshark + Npcap** e **Python
3.12 + `scapy` + `pydivert`**. O `INSTALAR.bat` cuida de tudo isso.

```powershell
npm start      # inicia o monitor e abre o painel (precisa de admin para capturar)
npm run dev    # inicia sem abrir o navegador
npm test       # testes (unit + integração + SNI + bloqueio)
```

Opções: `--web-port N`, `--dns-port N`, `--data-dir PASTA`, `--no-browser`,
`--gateway-ip IP`, `--victim-ip IP|all`. Sem argumentos, detecta o roteador e
monitora toda a rede. Dados e configuração ficam em `%LOCALAPPDATA%\MonitorInfantil\`
(fora do projeto). Defina `MONITOR_DEBUG=1` para ver todo SNI capturado.

## Estrutura

| Caminho | Papel |
|---|---|
| [src/main.js](src/main.js) | Orquestra captura + DNS + painel; detecção automática; encerramento gracioso |
| [src/sni/arp-mode.js](src/sni/arp-mode.js) | Detecta interface/gateway e coordena ARP + SNI |
| [src/sni/arp.js](src/sni/arp.js) | Controla o spoofer Python e o IP forwarding |
| [scripts/arp_spoof.py](scripts/arp_spoof.py) | ARP spoofing (IPv4) + supressão de IPv6 (RA), via scapy |
| [src/sni/sniffer.js](src/sni/sniffer.js) | Captura ClientHello (TCP+QUIC) via tshark e extrai o SNI |
| [src/sni/collector.js](src/sni/collector.js) | Classifica o SNI, deduplica, grava e decide bloqueio |
| [src/sni/blocker.js](src/sni/blocker.js) + [scripts/blocker.py](scripts/blocker.py) | Motor de bloqueio (WinDivert): descarta TCP/QUIC bloqueados |
| [src/block.js](src/block.js) | Regra de bloqueio (manual, palavra, categoria, anúncio) |
| [src/classify/](src/classify/) | Classificador, regras e verificação online (Cloudflare) |
| [src/dns/](src/dns/) | Servidor DNS complementar |
| [src/db.js](src/db.js) | SQLite: histórico, agregações, paginação |
| [src/web/server.js](src/web/server.js) | API local (127.0.0.1) e painel |
| [src/keepawake.js](src/keepawake.js) | Impede o PC de dormir enquanto monitora |
| [public/](public/) | Painel web (HTML/CSS/JS, sem dependências) |
| [scripts/instalar.ps1](scripts/instalar.ps1) | Instalador automático (deps, firewall, atalho, verificação) |
| [scripts/abrir.ps1](scripts/abrir.ps1) | Launcher: eleva a admin e mantém a janela aberta |

## Privacidade

Todos os dados capturados ficam **somente no computador local** (SQLite em
`%LOCALAPPDATA%\MonitorInfantil\`). Nada é enviado para fora.
