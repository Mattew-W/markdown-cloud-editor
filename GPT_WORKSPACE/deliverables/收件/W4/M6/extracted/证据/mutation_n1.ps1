# M6 W4 阶段定向变异 N1（只在副本上执行，正常 work 目录不受影响）
# 目的：让「正文读取阶段」失去超时保护，验证 M6-05 的 200/400 正文读取超时用例能否检出。
# 前置：work/frontend 基线先绿（17/17）。
$ErrorActionPreference = 'Stop'
# 路径按脚本自身位置推导，兼容两种布局：
#   交付包：<包根>\证据\mutation_n1.ps1 + <包根>\源码\frontend
#   work  ：<work>\evidence\mutation_n1.ps1 + <work>\frontend
$pkgRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $pkgRoot '源码\frontend'
if (-not (Test-Path -LiteralPath (Join-Path $src 'js\api.js'))) { $src = Join-Path $pkgRoot 'frontend' }
if (-not (Test-Path -LiteralPath (Join-Path $src 'js\api.js'))) { throw "找不到前端源码 js\api.js：$src" }
$mut    = Join-Path $pkgRoot 'mutation\frontend'
$logPath = Join-Path $pkgRoot 'log-mutation-n1.log'
$enc    = New-Object Text.UTF8Encoding($false)

# 1. 副本：只复制 js 与 package.json（api.http.test.js 不依赖第三方包）
if (Test-Path -LiteralPath $mut) { Remove-Item -LiteralPath $mut -Recurse -Force }
New-Item -ItemType Directory -Path $mut -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $src 'js') -Destination $mut -Recurse
Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination $mut

$api = Join-Path $mut 'js\api.js'
$hashBefore = (Get-FileHash -LiteralPath $api -Algorithm SHA256).Hash
$srcHash    = (Get-FileHash -LiteralPath (Join-Path $src 'js\api.js') -Algorithm SHA256).Hash
"副本 api.js SHA256 = $hashBefore"
"源   api.js SHA256 = $srcHash"
if ($hashBefore -ne $srcHash) { throw '副本与源不一致，停止变异' }

# 2. 注入：唯一锚点定位 fetch 返回处，只清定时器，不动错误分类分支
$text = [IO.File]::ReadAllText($api, $enc)
$anchor = @'
    const response = await fetchImpl(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
'@
$anchor = $anchor -replace "`r`n", "`n"
$text = $text -replace "`r`n", "`n"
$count = ([regex]::Matches($text, [regex]::Escape($anchor))).Count
"锚点命中次数 = $count（必须为 1，否则停止）"
if ($count -ne 1) { throw '锚点不唯一，放弃变异' }

$inject = @'
    const response = await fetchImpl(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    // 【W4 阶段定向变异 N1】只让正文读取阶段失去超时保护：fetch 已返回即清定时器
    if (timerId !== null) { timers.clearTimeout(timerId); timerId = null; }
'@
$inject = $inject -replace "`r`n", "`n"
$mutated = $text.Replace($anchor, $inject)
[IO.File]::WriteAllText($api, $mutated, $enc)

$line = (Select-String -LiteralPath $api -Pattern '阶段定向变异 N1' -Encoding UTF8 | Select-Object -First 1).LineNumber
"注入位置：js/api.js 第 $line 行附近（锚点后 1 行）"
"注入后的代码行："
(Select-String -LiteralPath $api -Pattern '阶段定向变异 N1' -Context 0,1 -Encoding UTF8) | ForEach-Object { $_.Line; $_.Context.PostContext }
"变异后 api.js SHA256 = $((Get-FileHash -LiteralPath $api -Algorithm SHA256).Hash)"

# 3. 只跑目标用例文件
Push-Location -LiteralPath $mut
node --test js/tests/api.http.test.js 2>&1 | Tee-Object -FilePath $logPath | Select-String -Pattern '^not ok|# (tests|pass|fail)' | Select-Object -Last 12
"EXIT 变异后目标用例 = $LASTEXITCODE"
Pop-Location

# 4. 还原副本并校验哈希一致
Copy-Item -LiteralPath (Join-Path $src 'js\api.js') -Destination $api -Force
$hashAfter = (Get-FileHash -LiteralPath $api -Algorithm SHA256).Hash
"还原后 api.js SHA256 = $hashAfter"
"与源一致：$($hashAfter -eq $srcHash)"

Push-Location -LiteralPath $mut
node --test js/tests/api.http.test.js 2>&1 | Select-String -Pattern '# (tests|pass|fail)' | Select-Object -Last 4
"EXIT 还原后目标用例 = $LASTEXITCODE"
Pop-Location
