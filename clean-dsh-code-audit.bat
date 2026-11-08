@echo off
chcp 65001>nul
setlocal EnableExtensions
title 清理 dsh-code-audit 安装残留

set "YES=0"
if /I "%~1"=="/y" set "YES=1"

echo ==========================================
echo   清理 dsh-code-audit 安装残留（Windows）
echo ==========================================
echo.

tasklist 2>nul | findstr /I "DeepSeek" >nul
if not errorlevel 1 (
  echo [提示] 检测到 DeepSeek Harness 仍在运行。
  echo        建议先完全退出（含托盘、后台进程），否则可能因文件占用清理失败。
  echo.
  if "%YES%"=="0" (
    choice /C YN /N /M "仍要继续？[Y=继续 N=退出] "
    if errorlevel 2 exit /b 1
  )
)

echo 将检查并清理以下 profile 的 node_modules 残留：
echo   %USERPROFILE%\.dsh\profiles\desktop
echo   %USERPROFILE%\.dsh\profiles\web
echo 规则：只删除 dsh-code-audit 相关目录；package.json 已声明的正式安装会保留。
echo.
if "%YES%"=="0" (
  choice /C YN /N /M "确认执行？[Y/N] "
  if errorlevel 2 exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; foreach($p in @('desktop','web')){ $root=Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles') $p; $nm=Join-Path $root 'node_modules'; if(-not (Test-Path $nm)){ Write-Host ('[' + $p + '] 无 node_modules，跳过'); continue }; $pkg=Join-Path $root 'package.json'; $declared=(Select-String -Path $pkg -Pattern 'dsh-code-audit' -Quiet); $removed=0; if($declared){ $tmp=@(Get-ChildItem $nm -Force | Where-Object { $_.Name -like 'dsh-code-audit_tmp_*' }); foreach($t in $tmp){ Remove-Item -LiteralPath $t.FullName -Recurse -Force; Write-Host ('[' + $p + '] 已清理临时目录 ' + $t.Name); $removed++ }; Write-Host ('[' + $p + '] package.json 已声明该依赖，保留正式安装'); } else { $all=@(Get-ChildItem $nm -Force | Where-Object { $_.Name -like 'dsh-code-audit*' }); $pnpm=@(Get-ChildItem (Join-Path $nm '.pnpm') -Force | Where-Object { $_.Name -like '*code-audit*' }); foreach($t in @($pnpm + $all)){ if($t.PSIsContainer -eq $false){ continue }; if($t.LinkType){ [System.IO.Directory]::Delete($t.FullName,$false) } else { Remove-Item -LiteralPath $t.FullName -Recurse -Force }; Write-Host ('[' + $p + '] 已清理 ' + $t.Name); $removed++ }; if($removed -eq 0){ Write-Host ('[' + $p + '] 无需清理') } } }; Write-Host ''; Write-Host '检查结果：'; $left=@(); foreach($p in @('desktop','web')){ $nm=Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles') ($p + '\node_modules'); if(Test-Path $nm){ $left += @(Get-ChildItem $nm -Force | Where-Object { $_.Name -like 'dsh-code-audit*' } | ForEach-Object { $p + ': ' + $_.Name }) } }; if($left.Count -eq 0){ Write-Host '  已清理干净，可直接在市场重新安装 dsh-code-audit' } else { Write-Host '  仍有残留（多为已声明的正式安装）：'; $left | ForEach-Object { Write-Host ('  - ' + $_) } }"

echo.
echo [完成] 若重装后命令/技能未刷新，请完全重启 DeepSeek Harness。
if "%YES%"=="0" pause
endlocal
