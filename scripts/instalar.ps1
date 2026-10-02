# ============================================================
#  Instalador do Monitor de Rede
#  Prepara tudo automaticamente para uma pessoa leiga:
#  Node.js, Wireshark/Npcap, Python, scapy, pydivert, firewall
#  e um atalho na Area de Trabalho. Pode ser rodado varias vezes
#  com seguranca (so instala o que faltar).
# ============================================================
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ROOT = Split-Path $PSScriptRoot -Parent
$LOG  = Join-Path $env:TEMP 'MonitorDeRede-instalacao.log'
"=== Instalacao iniciada em $(Get-Date) ===" | Out-File $LOG -Encoding utf8

function Say([string]$msg, [string]$color = 'White') {
  Write-Host $msg -ForegroundColor $color
  $msg | Out-File $LOG -Append -Encoding utf8
}
function Step([string]$n, [string]$msg) { Say "" ; Say "[$n] $msg" 'Cyan' }
function Ok([string]$msg)   { Say "   OK  - $msg" 'Green' }
function Warn([string]$msg) { Say "   !   - $msg" 'Yellow' }
function Fail([string]$msg) { Say "   X   - $msg" 'Red' }

Clear-Host
Say "============================================================" 'Cyan'
Say "        Monitor de Rede - Instalacao automatica" 'Cyan'
Say "============================================================" 'Cyan'
Say "Isto prepara o computador uma unica vez. Pode demorar alguns"
Say "minutos e baixar programas da internet. Pode deixar rodando."
Say ""

# ---- Pre-checagens -------------------------------------------------------
$win = [System.Environment]::OSVersion.Version
if ($win.Major -lt 10) { Fail "Este programa precisa do Windows 10 ou 11."; Read-Host "Enter para sair"; exit 1 }

$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $hasWinget) { Warn "O 'winget' nao foi encontrado; usarei download direto quando precisar." }

# Pasta temporaria para downloads
$DL = Join-Path $env:TEMP 'MonitorDeRede-downloads'
New-Item -ItemType Directory -Force -Path $DL | Out-Null

function Download([string]$url, [string]$dest) {
  try {
    Say "        baixando: $url"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
    return (Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)
  } catch { Warn "download falhou: $($_.Exception.Message)"; return $false }
}

function Winget-Install([string]$id) {
  if (-not $hasWinget) { return $false }
  try {
    Say "        winget install $id ..."
    $p = Start-Process winget -ArgumentList @(
      'install','-e','--id',$id,'--silent',
      '--accept-source-agreements','--accept-package-agreements'
    ) -Wait -PassThru -WindowStyle Hidden
    return ($p.ExitCode -eq 0 -or $p.ExitCode -eq -1978335189) # 0 = ok; o 2o = "ja instalado"
  } catch { Warn "winget falhou: $($_.Exception.Message)"; return $false }
}

# ---- Localizadores ------------------------------------------------------
function Find-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:ProgramFiles(x86)\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
function Find-Tshark {
  foreach ($p in @("$env:ProgramFiles\Wireshark\tshark.exe", "${env:ProgramFiles(x86)}\Wireshark\tshark.exe")) {
    if (Test-Path $p) { return $p }
  }
  $c = Get-Command tshark -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}
function Find-Python {
  # Ignora o "stub" da Microsoft Store (tem 0 bytes ou abre a Store).
  $base = Join-Path $env:LOCALAPPDATA 'Programs\Python'
  if (Test-Path $base) {
    $exe = Get-ChildItem $base -Recurse -Filter python.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -gt 0 } | Select-Object -First 1
    if ($exe) {
      try { & $exe.FullName --version *> $null; if ($LASTEXITCODE -eq 0) { return $exe.FullName } } catch {}
    }
  }
  foreach ($p in @("$env:ProgramFiles\Python312\python.exe","$env:ProgramFiles\Python313\python.exe","$env:ProgramFiles\Python311\python.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
function Find-Npcap {
  return (Test-Path "$env:SystemRoot\System32\Npcap\wpcap.dll") -or
         (Test-Path "$env:SystemRoot\System32\wpcap.dll") -or
         [bool](Get-Service npcap -ErrorAction SilentlyContinue)
}

# ========================================================================
# 1) Node.js
# ========================================================================
Step "1/6" "Verificando o Node.js (motor do programa)..."
$node = Find-Node
if ($node) { Ok "Node.js ja instalado ($node)" }
else {
  Warn "Node.js nao encontrado. Instalando..."
  [void](Winget-Install 'OpenJS.NodeJS.LTS')
  $node = Find-Node
  if (-not $node) {
    $msi = Join-Path $DL 'node-lts.msi'
    if (Download 'https://nodejs.org/dist/v22.13.0/node-v22.13.0-x64.msi' $msi) {
      Start-Process msiexec -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    }
    $node = Find-Node
  }
  if ($node) { Ok "Node.js instalado." } else { Fail "Nao consegui instalar o Node.js. Veja o log: $LOG" }
}

# ========================================================================
# 2) Npcap (driver de captura) + Wireshark
#    Instalamos o Npcap ANTES do Wireshark: assim o Wireshark nao abre o
#    instalador do Npcap no meio (que pediria cliques).
# ========================================================================
Step "2/6" "Verificando o componente de captura (Npcap + Wireshark)..."
if (Find-Npcap) { Ok "Driver de captura (Npcap) ja presente." }
else {
  Warn "Instalando o driver de captura (Npcap)..."
  $npcap = Join-Path $DL 'npcap.exe'
  if (Download 'https://npcap.com/dist/npcap-1.79.exe' $npcap) {
    Start-Process $npcap -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue
    Start-Sleep 3
    if (-not (Find-Npcap)) {
      Warn "A instalacao automatica do Npcap pediu confirmacao. Abrindo o instalador:"
      Warn "  -> Clique em 'I Agree' e 'Install', deixe tudo como esta, depois 'Next/Finish'."
      Start-Process $npcap -Wait -ErrorAction SilentlyContinue
    }
  }
  if (Find-Npcap) { Ok "Npcap instalado." } else { Warn "Npcap nao confirmado (a captura pode falhar)." }
}

$tshark = Find-Tshark
if ($tshark) { Ok "Wireshark ja instalado ($tshark)" }
else {
  Warn "Instalando o Wireshark..."
  [void](Winget-Install 'WiresharkFoundation.Wireshark')
  $tshark = Find-Tshark
  if (-not $tshark) {
    $msi = Join-Path $DL 'wireshark.msi'
    if (Download 'https://2.na.dl.wireshark.org/win64/all-versions/Wireshark-4.6.8-x64.msi' $msi) {
      Start-Process msiexec -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    }
    $tshark = Find-Tshark
  }
  if ($tshark) { Ok "Wireshark instalado." } else { Warn "Wireshark pode exigir instalacao manual." }
}

# ========================================================================
# 3) Python
# ========================================================================
Step "3/6" "Verificando o Python (motor de rede)..."
$py = Find-Python
if ($py) { Ok "Python ja instalado ($py)" }
else {
  Warn "Python nao encontrado. Instalando..."
  [void](Winget-Install 'Python.Python.3.12')
  $py = Find-Python
  if (-not $py) {
    $pyexe = Join-Path $DL 'python.exe'
    if (Download 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' $pyexe) {
      Start-Process $pyexe -ArgumentList '/quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0' -Wait
    }
    $py = Find-Python
  }
  if ($py) { Ok "Python instalado." } else { Fail "Nao consegui instalar o Python. Veja o log: $LOG" }
}

# ========================================================================
# 4) Bibliotecas do Python (scapy, pydivert)
# ========================================================================
Step "4/6" "Instalando as bibliotecas de rede (scapy e pydivert)..."
if ($py) {
  try {
    & $py -m pip install --quiet --upgrade pip *>> $LOG
    & $py -m pip install --quiet --upgrade scapy pydivert *>> $LOG
    & $py -c "import scapy, pydivert" *> $null
    if ($LASTEXITCODE -eq 0) { Ok "scapy e pydivert prontos." }
    else { Warn "Tentando novamente a instalacao das bibliotecas..."; & $py -m pip install scapy pydivert *>> $LOG;
           & $py -c "import scapy, pydivert" *> $null
           if ($LASTEXITCODE -eq 0) { Ok "scapy e pydivert prontos." } else { Fail "Falha nas bibliotecas. Log: $LOG" } }
  } catch { Fail "Erro ao instalar bibliotecas: $($_.Exception.Message)" }
} else { Fail "Sem Python, nao da para instalar as bibliotecas." }

# ========================================================================
# 5) Firewall (libera a entrada para o monitoramento)
# ========================================================================
Step "5/6" "Liberando o Firewall do Windows para o monitor..."
try {
  netsh advfirewall firewall delete rule name="Monitor de Rede" *> $null
  netsh advfirewall firewall add rule name="Monitor de Rede" dir=in action=allow protocol=UDP localport=53 *> $null
  netsh advfirewall firewall add rule name="Monitor de Rede (TCP)" dir=in action=allow protocol=TCP localport=8484 *> $null
  if ($node) {
    netsh advfirewall firewall add rule name="Monitor de Rede (Node)" dir=in action=allow program="$node" enable=yes *> $null
  }
  Ok "Firewall liberado."
} catch { Warn "Nao consegui ajustar o firewall (o monitor ainda deve funcionar)." }

# ========================================================================
# 6) Atalho na Area de Trabalho
# ========================================================================
Step "6/6" "Criando o atalho 'Monitor de Rede' na Area de Trabalho..."
try {
  $abrir    = Join-Path $ROOT 'scripts\abrir.ps1'
  $desktop  = [Environment]::GetFolderPath('Desktop')
  $lnkPath  = Join-Path $desktop 'Monitor de Rede.lnk'
  $pwsh = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
  if (-not $pwsh) { $pwsh = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  # O atalho roda um PowerShell OCULTO que, por sua vez, abre o monitor numa
  # janela elevada VISIVEL que permanece aberta. Sem janelas piscando.
  $sc.TargetPath       = $pwsh
  $sc.Arguments        = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$abrir"""
  $sc.WorkingDirectory = $ROOT
  $sc.IconLocation     = "$env:SystemRoot\System32\imageres.dll,77"  # icone de escudo/seguranca
  $sc.Description      = 'Abrir o Monitor de Rede'
  $sc.Save()
  Ok "Atalho criado na Area de Trabalho."
} catch { Warn "Nao consegui criar o atalho (voce pode abrir pela pasta 'scripts\start-arp.bat')." }

# ========================================================================
# Verificacao final — confirma que TUDO funciona de verdade
# ========================================================================
Step "Final" "Conferindo se esta tudo funcionando..."
$problemas = @()

if ($node -and (Test-Path $node)) { Ok "Node.js (motor do programa)." }
else { $problemas += "Node.js"; Fail "Node.js nao encontrado." }

$tshark = Find-Tshark
if ($tshark) { Ok "Captura de sites (Wireshark)." }
else { $problemas += "Wireshark"; Fail "Wireshark nao encontrado." }

if (Find-Npcap) { Ok "Driver de captura (Npcap)." }
else { $problemas += "Npcap"; Fail "Npcap nao detectado." }

$py = Find-Python
$libok = $false
if ($py) {
  & $py -c "import scapy, pydivert" *> $null
  $libok = ($LASTEXITCODE -eq 0)
}
if ($libok) { Ok "Motor de rede (Python + scapy + pydivert)." }
else { $problemas += "Python/scapy/pydivert"; Fail "Bibliotecas de rede nao prontas." }

# ========================================================================
# Conclusao
# ========================================================================
Say ""
if ($problemas.Count -eq 0) {
  Say "============================================================" 'Green'
  Say "            TUDO PRONTO! Instalacao 100% completa." 'Green'
  Say "============================================================" 'Green'
  Say ""
  Say "Para usar: clique duas vezes no atalho 'Monitor de Rede'" 'White'
  Say "na Area de Trabalho e clique SIM quando o Windows perguntar." 'White'
  Say ""
  Say "O painel abre sozinho no navegador. Deixe a janela aberta"
  Say "enquanto quiser acompanhar."
} else {
  Say "============================================================" 'Yellow'
  Say "   ATENCAO: alguns componentes nao ficaram prontos:" 'Yellow'
  foreach ($p in $problemas) { Say ("     - " + $p) 'Yellow' }
  Say ""
  Say "Rode este INSTALAR.bat de novo (ele completa o que falta)." 'Yellow'
  Say "Se continuar, confira a internet e veja o log: $LOG" 'Yellow'
}
Say ""
Read-Host "Pressione Enter para fechar esta janela"
