# probe_api_w6_p2.ps1 —— 补充探针：T04 同版本并发、T11 的 429 Retry-After 与 5xx
param(
    [string]$Base = "http://127.0.0.1:18080",
    [string]$UserA = "w6probe_a",
    [string]$Pass = "<DEMO-PASSWORD>"
)
$ErrorActionPreference = "Stop"

function Call([string]$method, [string]$path, $token, $body) {
    $headers = @{}
    if ($token) { $headers["Authorization"] = "Bearer $token" }
    $params = @{ Method = $method; Uri = "$Base$path"; SkipHttpErrorCheck = $true; TimeoutSec = 30 }
    if ($headers.Count -gt 0) { $params["Headers"] = $headers }
    if ($null -ne $body) { $params["Body"] = ($body | ConvertTo-Json -Compress); $params["ContentType"] = "application/json" }
    $r = Invoke-WebRequest @params
    [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content; retry = ($r.Headers["Retry-After"] -join ",") }
}

# 登录（限流窗口内重试）
$login = $null
for ($i = 0; $i -lt 20; $i++) {
    $login = Call POST "/api/v1/auth/login" $null @{ username = $UserA; password = $Pass }
    if ($login.status -eq 200) { break }
    "[等待限流窗口] 第 $i 次登录返回 $($login.status)，Retry-After=$($login.retry)"
    Start-Sleep -Seconds 5
}
"登录结果: $($login.status)"
$tokenA = ($login.body | ConvertFrom-Json).token

# ---------- T04 同版本并发 ----------
$doc = Call POST "/api/v1/documents" $tokenA @{ title = "T04 并发"; content = "base" }
$docId = ($doc.body | ConvertFrom-Json).id
"T04-初始: id=$docId version=1"

$payloads = @(
    @{ title = "T04 并发"; content = "winner-A"; expected_version = 1 },
    @{ title = "T04 并发"; content = "winner-B"; expected_version = 1 }
)
$results = $payloads | ForEach-Object -Parallel {
    $h = @{ Authorization = "Bearer " + $using:tokenA }
    $b = ($_ | ConvertTo-Json -Compress)
    $r = Invoke-WebRequest -Method PUT -Uri "$using:Base/api/v1/documents/$using:docId" -Headers $h -Body $b -ContentType "application/json" -SkipHttpErrorCheck -TimeoutSec 30
    [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content }
} -ThrottleLimit 2

foreach ($r in $results) { "T04-并发PUT status=$($r.status) body=$($r.body)" }
$final = (Call GET "/api/v1/documents/$docId" $tokenA).body | ConvertFrom-Json
"T04-最终行: version=$($final.version) content=$($final.content)"
"T04-成功次数=" + (@($results | Where-Object { $_.status -eq 200 }).Count) + " 409次数=" + (@($results | Where-Object { $_.status -eq 409 }).Count)

# ---------- T11 429 的 Retry-After ----------
$hit = $null
for ($i = 0; $i -lt 16; $i++) {
    $r = Call POST "/api/v1/auth/login" $null @{ username = $UserA; password = "wrong-pass-w6-probe" }
    if ($r.status -eq 429) { $hit = $r; break }
}
if ($hit) { "T11-429: status=$($hit.status) Retry-After=$($hit.retry) body=$($hit.body)" } else { "T11-429: 未触发" }

Set-Content -LiteralPath "$env:TEMP\w6_probe_token.txt" -Value $tokenA -Encoding utf8
"token 已写入 `$env:TEMP\w6_probe_token.txt，供停库后的 5xx 探针复用"
"T11-5xx: 由 probe_api_w6_p3.ps1 在停库窗口内执行"

# 清理
$v = ((Call GET "/api/v1/documents/$docId" $tokenA).body | ConvertFrom-Json).version
Call DELETE "/api/v1/documents/$docId`?expected_version=$v" $tokenA $null | Out-Null
"T04 探针文档已清理"

