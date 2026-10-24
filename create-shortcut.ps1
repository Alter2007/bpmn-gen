# 在桌面创建应用快捷方式（现场生成，不依赖仓库里已有 .lnk）
# 这个文件含中文，必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 会乱码。
# 可选参数 -Destination 指定输出路径（用于自检，不传就是桌面）。

param(
    [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root '启动应用.vbs'
$icon = Join-Path $root 'assets\app.ico'

if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Host "[错误] 找不到启动器: $launcher" -ForegroundColor Red
    exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
if ($Destination -ne '') {
    $lnkPath = $Destination
} else {
    $lnkPath = Join-Path $desktop 'BPMN 生成器.lnk'
}

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnkPath)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + $launcher + '"'
$s.WorkingDirectory = $root
if (Test-Path -LiteralPath $icon) { $s.IconLocation = $icon + ',0' }
$s.Description = 'BPMN 审批流生成器 —— 一句话生成可部署的审批流'
$s.WindowStyle = 1
$s.Save()

if (Test-Path -LiteralPath $lnkPath) {
    Write-Host ''
    Write-Host '[OK] 已在桌面创建快捷方式：' -ForegroundColor Green
    Write-Host "     $lnkPath"
    Write-Host ''
    Write-Host '     双击它即可打开应用（无需命令行）。'
} else {
    Write-Host '[错误] 创建失败，请手动把 BPMN 生成器.lnk 拖到桌面。' -ForegroundColor Red
    exit 1
}
