'use strict';

// O módulo node:sqlite ainda emite um aviso "experimental"; não queremos
// assustar a usuária com ele no console.
const defaultWarning = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') defaultWarning.forEach((fn) => fn(w));
});

const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { Config, dataDir, parseArgs } = require('./config');
const { Store } = require('./db');
const { DnsServer } = require('./dns/server');
const { ProbeQueue } = require('./classify/familyFilter');
const { createWebServer } = require('./web/server');
const { localAddresses, startArpRefresh } = require('./network');
const { ArpMode, gateway4 } = require('./sni/arp-mode');
const { SNICollector } = require('./sni/collector');
const { Blocker } = require('./sni/blocker');
const { tsharkPath } = require('./sni/sniffer');
const { pythonPath } = require('./sni/arp');
const { KeepAwake } = require('./keepawake');

/**
 * Confere as dependências externas e devolve uma lista amigável do que falta.
 * Não é fatal: o painel funciona mesmo assim; só avisamos para reinstalar.
 */
function checkDependencies() {
  const missing = [];
  // Wireshark/tshark (captura dos sites).
  const tp = tsharkPath();
  let tsharkOk = tp && tp !== 'tshark' && fs.existsSync(tp);
  if (!tsharkOk) {
    try { execFileSync('where', ['tshark'], { windowsHide: true, stdio: 'ignore' }); tsharkOk = true; } catch {}
  }
  if (!tsharkOk) missing.push('Wireshark (para ver os sites acessados)');

  // Python real + bibliotecas scapy/pydivert.
  const py = pythonPath();
  const pyOk = py && py.toLowerCase() !== 'python' && fs.existsSync(py);
  if (!pyOk) {
    missing.push('Python (motor de rede)');
  } else {
    try {
      execFileSync(py, ['-c', 'import scapy, pydivert'], { windowsHide: true, timeout: 20000, stdio: 'ignore' });
    } catch {
      missing.push('Bibliotecas de rede (scapy/pydivert)');
    }
  }
  return missing;
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

function tryConfigureFirewall() {
  if (process.platform === 'win32') {
    execFile(
      'netsh',
      ['advfirewall', 'firewall', 'add', 'rule', 'name=Monitor Infantil DNS', 'dir=in', 'action=allow', 'protocol=UDP', 'localport=53'],
      { windowsHide: true },
      () => {} // Ignora silenciosamente se não for admin
    );
  }
}

function fatal(message) {
  console.error('\n[ERRO] ' + message + '\n');
  if (process.stdin.isTTY) {
    console.error('Pressione Enter para fechar.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
}

/**
 * Inicia o modo ARP: intercepta tráfego do(s) alvo(s) e captura SNI.
 */
async function startArpMode(collector, runtime, args) {
  // Sem configuração manual, o monitor cuida de tudo: detecta o roteador e
  // monitora todos os aparelhos da rede automaticamente.
  const gatewayIp = args.gatewayIp || gateway4();
  const victims = args.victimIp
    ? (args.victimIp.toLowerCase() === 'all' ? 'all' : args.victimIp.split(',').map((s) => s.trim()))
    : 'all';

  console.log('');
  console.log('  Iniciando monitoramento automático da rede...');

  if (!gatewayIp) {
    console.log('  [!] Não consegui detectar o roteador da rede. Verifique a conexão.');
    runtime.arpMode = 'failed';
    return null;
  }

  let lastErr = '';
  const arpMode = new ArpMode(
    (ev) => collector.handle(ev),
    (err) => { lastErr = err.message; console.error('[ARP] ' + err.message); }
  );

  const ok = await arpMode.start(victims, gatewayIp);
  if (!ok) {
    console.log('  [!] Não consegui iniciar a captura: ' + (lastErr || 'motivo desconhecido'));
    console.log('      O painel continua disponível no navegador.');
    console.log('      (Se isto for uma máquina virtual, troque a rede dela para');
    console.log('       o modo "Placa em ponte / Bridged" para testar a captura real.)');
    runtime.arpMode = 'failed';
    return null;
  }

  runtime.arpMode = 'active';
  runtime.victimIp = victims === 'all' ? 'all' : victims.join(', ');
  runtime.gatewayIp = gatewayIp;
  console.log('  [OK] Modo ARP ATIVO. Tráfego interceptado.');
  return arpMode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dataDir || dataDir();
  const config = new Config(dir);
  const dnsPort = args.dnsPort || config.get('dnsPort');
  const webPort = args.webPort || config.get('webPort');
  const panelUrl = `http://127.0.0.1:${webPort}/`;

  const store = new Store(path.join(dir, 'monitor.db'));
  const probeQueue = new ProbeQueue((site, category) => store.applyProbeResult(site, category));
  const dns = new DnsServer({ store, config, probeQueue });
  const blocker = new Blocker({ store, config });
  const collector = new SNICollector({
    store,
    config,
    probeQueue,
    onBlock: (ev) => blocker.onBlocked(ev),
  });

  // Dados de modo ARP; expostos ao painel.
  const runtime = { arpMode: 'inactive', victimIp: null, gatewayIp: null };
  const web = createWebServer({
    store,
    config,
    dnsServer: dns,
    dnsPort,
    webPort,
    sniStatus: () => ({ ...collector.stats, arp: runtime }),
  });

  try {
    await web.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.log('O monitor já está aberto. Abrindo o painel...');
      if (args.openBrowser) openBrowser(panelUrl);
      return;
    }
    throw err;
  }

  // O DNS é um complemento (registra tráfego não-criptografado e permite bloqueio).
  // Se a porta 53 estiver ocupada, não é fatal — o SNI é a fonte principal.
  let dnsOn = false;
  try {
    tryConfigureFirewall();
    await dns.start(dnsPort);
    dnsOn = true;
  } catch (err) {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.log('  [i] Filtro de DNS complementar inativo (porta 53 ocupada).');
    } else {
      await web.close();
      throw err;
    }
  }

  if (config.get('onlineCheck')) store.unknownSites().forEach((s) => probeQueue.push(s));

  startArpRefresh(store);
  const purge = () => {
    const n = store.purgeOlderThan(config.get('retentionDays'));
    if (n) console.log(`[limpeza] ${n} registros antigos removidos`);
  };
  purge();
  setInterval(purge, 6 * 60 * 60_000).unref();

  const missing = checkDependencies();
  if (missing.length) {
    console.log('');
    console.log('  ============================================================');
    console.log('   Faltam componentes para o monitoramento funcionar 100%:');
    for (const m of missing) console.log('     - ' + m);
    console.log('');
    console.log('   Solução: feche esta janela e clique duas vezes em');
    console.log('   "INSTALAR.bat" (na pasta do programa). Depois abra de novo.');
    console.log('  ============================================================');
  }

  let arp = null;
  try {
    arp = await startArpMode(collector, runtime, args);
  } catch (err) {
    console.log('  [!] Não foi possível iniciar o modo ARP: ' + err.message);
    console.log('      O painel continua funcionando; verifique os IPs e tente novamente.');
  }

  // O bloqueio efetivo (WinDivert) só faz sentido quando estamos interceptando.
  const keepAwake = new KeepAwake();
  if (runtime.arpMode === 'active') {
    try {
      blocker.start();
    } catch (err) {
      console.log('  [!] Não foi possível iniciar o motor de bloqueio: ' + err.message);
    }
    // Mantém o PC acordado: se ele dormir, o celular (com o tráfego passando
    // pelo PC) fica sem internet. Liberado automaticamente ao encerrar.
    keepAwake.start();
  }

  console.log('====================================================');
  console.log(' Monitor de Rede em execução (Modo ARP)');
  console.log('====================================================');
  console.log(` Painel:      ${panelUrl}`);
  console.log(` Dados em:    ${dir}`);
  if (dnsOn) {
    console.log(` DNS complementar ativo na porta ${dnsPort}.`);
  }
  if (runtime.arpMode === 'active') {
    console.log(` Monitorando a rede automaticamente.`);
  } else {
    console.log(` [!] A captura não iniciou (veja a mensagem acima), mas o painel está no ar.`);
  }
  console.log(' Mantenha esta janela aberta. Para encerrar, feche-a ou use Ctrl+C.');
  console.log('====================================================');

  if (args.openBrowser) openBrowser(panelUrl);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    keepAwake.stop();
    collector.stop();
    await blocker.stop();
    if (arp) await arp.stop(); // restaura o ARP para o celular não ficar sem internet
    await Promise.allSettled([dns.stop(), web.close()]);
    store.close();
    process.exit(0);
  };
  // Cobre Ctrl+C, término e o fechamento da janela do console no Windows.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, shutdown); } catch {}
  }
}

main().catch((err) => fatal(err.stack || String(err)));
