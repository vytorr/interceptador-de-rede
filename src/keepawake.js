'use strict';

const { spawn } = require('node:child_process');

// Enquanto o monitor roda, o celular manda o tráfego para o PC (ARP). Se o PC
// dormir, o celular fica "conectado, sem internet". Isto mantém o Windows
// acordado (sem impedir que a TELA apague) e libera automaticamente ao sair.
const SCRIPT = `
Add-Type -Name Power -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$CONT = [uint32]"0x80000000"; $SYS = [uint32]"0x00000001"
while ($true) {
  [Win32.Power]::SetThreadExecutionState($CONT -bor $SYS) | Out-Null
  Start-Sleep -Seconds 40
}
`;

class KeepAwake {
  constructor() {
    this.process = null;
  }

  start() {
    if (process.platform !== 'win32') return false;
    try {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      this.process = spawn(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: 'ignore' }
      );
      this.process.on('error', () => {});
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
  }
}

module.exports = { KeepAwake };
