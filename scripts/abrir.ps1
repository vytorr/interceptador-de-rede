# ============================================================
#  Abre o Monitor de Rede: eleva a admin e mantem a janela
#  aberta enquanto o monitor roda (ou mostra o erro, se houver).
# ============================================================
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ROOT = Split-Path $PSScriptRoot -Parent

# --- Garante privilegios de administrador ---
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
  [Security.Principal.WindowsBuiltinRole]::Administrator)

if (-not $isAdmin) {
  # Reabre ESTE script elevado, numa janela VISIVEL (sem -WindowStyle Hidden).
  try {
    Start-Process powershell -Verb RunAs -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSCommandPath + '"')
    )
  } catch {
    Write-Host "Permissao de administrador negada. O monitor precisa dela para funcionar." -ForegroundColor Red
    Start-Sleep 4
  }
  return
}

# --- A partir daqui estamos como administrador ---
# Garante que ESTA janela fique VISIVEL. O atalho pode ter aberto o PowerShell
# oculto; se formos nos que vamos rodar o monitor, mostramos a janela para a
# pessoa poder acompanhar e, principalmente, FECHAR para encerrar com seguranca
# (o fechamento restaura o ARP e evita o celular ficar sem internet).
try {
  $win = Add-Type -PassThru -Name WinShow -Namespace MonitorRede -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
  $h = $win::GetConsoleWindow()
  if ($h -ne [System.IntPtr]::Zero) { [void]$win::ShowWindow($h, 5) }  # 5 = SW_SHOW
} catch {}

$host.UI.RawUI.WindowTitle = 'Monitor de Rede'
Set-Location $ROOT

# Localiza o Node (PATH ou pasta padrao)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path $p) { $node = $p; break }
  }
}

if (-not $node) {
  Write-Host ""
  Write-Host "============================================================" -ForegroundColor Yellow
  Write-Host "  O Monitor ainda nao foi instalado corretamente." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Feche esta janela e clique duas vezes em 'INSTALAR.bat'"
  Write-Host "  (na pasta do programa). Depois use o atalho de novo."
  Write-Host "============================================================" -ForegroundColor Yellow
  Write-Host ""
  Read-Host "Pressione Enter para fechar"
  return
}

Write-Host ""
Write-Host "  Iniciando o Monitor de Rede... (nao feche esta janela)" -ForegroundColor Cyan
Write-Host ""

# Roda o monitor. A janela permanece enquanto ele estiver ativo.
& $node (Join-Path $ROOT 'src\main.js')

# So chega aqui quando o monitor encerra (ou se houve erro acima).
Write-Host ""
Write-Host "============================================================"
Write-Host "  O Monitor foi encerrado."
Write-Host "  Se o painel nao abriu, acesse:  http://127.0.0.1:8484"
Write-Host "============================================================"
Write-Host ""
Read-Host "Pressione Enter para fechar"
