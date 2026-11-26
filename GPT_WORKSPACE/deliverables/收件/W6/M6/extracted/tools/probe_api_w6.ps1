# probe_api_w6.ps1 —— T01/T02/T04/T11/T14 的 HTTP 层实测探针（演示脚手架，不属于仓库产品代码）
# 用法：pwsh -NoProfile -File probe_api_w6.ps1 -Base http://127.0.0.1:18080
param(
    [string]$Base = "http://127.0.0.1:18080",
    [string]$UserA = "w6probe_a",
    [string]$UserB = "w6probe_b",
    [string]$Pass = "<DEMO-PASSWORD>"
)

$ErrorActionPreference = "Stop"
function Call([string]$method, [string]$path, $token, $body, [string]$contentType = "application/json") {
    $headers = @{}
    if ($token) { $headers["Authorization"] = "Bearer $token" }
    $params = @{ Method = $method; Uri = "$Base$path"; SkipHttpErrorCheck = $true; TimeoutSec = 30 }
    if ($headers.Count -gt 0) { $params["Headers"] = $headers }
    if ($null -ne $body) {
        $params["Body"] = if ($body -is [string]) { $body } else { ($body | ConvertTo-Json -Depth 5 -Compress) }
        $params["ContentType"] = $contentType
    }
    $r = Invoke-WebRequest @params
    [pscustomobject]@{
        status = [int]$r.StatusCode
        body   = $r.Content
        retry  = $r.Headers["Retry-After"]
    }
}
function Show([string]$case, [string]$expect, $res) {
    $text = if ($res.body.Length -gt 300) { $res.body.Substring(0, 300) + "…" } else { $res.body }
    "[{0}] 期望 {1} | 实际 {2} | Retry-After={3}`n      {4}" -f $case, $expect, $res.status, $res.retry, $text
}

# ---------- 账号准备 ----------
$regA = Call POST "/api/v1/auth/register" $null @{ username = $UserA; password = $Pass }
if ($regA.status -eq 409) { $regA = Call POST "/api/v1/auth/login" $null @{ username = $UserA; password = $Pass } }
Show "REG-A" "201/200" $regA
$tokenA = ($regA.body | ConvertFrom-Json).token

$regB = Call POST "/api/v1/auth/register" $null @{ username = $UserB; password = $Pass }
if ($regB.status -eq 409) { $regB = Call POST "/api/v1/auth/login" $null @{ username = $UserB; password = $Pass } }
Show "REG-B" "201/200" $regB
$tokenB = ($regB.body | ConvertFrom-Json).token

# ---------- T01 注册/登录/过期或篡改 token ----------
$login = Call POST "/api/v1/auth/login" $null @{ username = $UserA; password = $Pass }
Show "T01-login-ok" "200" $login
"T01-响应含 password_hash: " + ($login.body -match 'password_hash|passwordHash')
$badToken = $tokenA.Substring(0, $tokenA.Length - 6) + "abcdef"
$r401 = Call GET "/api/v1/documents" $badToken
Show "T01-篡改token" "401" $r401
$noToken = Call GET "/api/v1/documents" $null
Show "T01-无token" "401" $noToken
"T01-401 结构: " + $r401.body

# ---------- T02 跨账号 ----------
$doc = Call POST "/api/v1/documents" $tokenA @{ title = "T02 私有文档"; content = "A 的正文" }
Show "T02-create" "201" $doc
$docId = ($doc.body | ConvertFrom-Json).id
$before = (Call GET "/api/v1/documents/$docId" $tokenA).body
Show "T02-B-get" "404" (Call GET "/api/v1/documents/$docId" $tokenB)
Show "T02-B-put" "404" (Call PUT "/api/v1/documents/$docId" $tokenB @{ title = "B 改标题"; content = "B 的正文"; expected_version = 1 })
Show "T02-B-delete" "404" (Call DELETE "/api/v1/documents/$docId`?expected_version=1" $tokenB $null)
$after = (Call GET "/api/v1/documents/$docId" $tokenA).body
"T02-前后一致: " + ($before -eq $after) + " | version=" + (($after | ConvertFrom-Json).version)

# ---------- T04 同版本并发 ----------
$doc2 = Call POST "/api/v1/documents" $tokenA @{ title = "T04 并发"; content = "base" }
$doc2Id = ($doc2.body | ConvertFrom-Json).id
$jobs = @(
    @{ content = "winner-1"; expected_version = 1 },
    @{ content = "winner-2"; expected_version = 1 }
)
$results = $jobs | ForEach-Object -Parallel {
    $h = @{ Authorization = "Bearer " + $using:tokenA }
    $b = ($_ | ConvertTo-Json -Compress)
    $r = Invoke-WebRequest -Method PUT -Uri "$using:Base/api/v1/documents/$using:doc2Id" -Headers $h -Body $b -ContentType "application/json" -SkipHttpErrorCheck -TimeoutSec 30
    [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content }
} -ThrottleLimit 2
foreach ($r in $results) { Show "T04-并发PUT" "一个200/一个409" $r }
$final = (Call GET "/api/v1/documents/$doc2Id" $tokenA).body | ConvertFrom-Json
"T04-最终行: version=$($final.version) content=$($final.content)"

# ---------- T11 413 / 429 ----------
$big = ("x" * 300000)
Show "T11-413-正文超限" "413" (Call PUT "/api/v1/documents/$docId" $tokenA @{ title = "超限"; content = $big; expected_version = 1 })
Show "T11-413-请求体超2MiB" "413" (Call POST "/api/v1/documents" $tokenA @{ title = "超限体"; content = $big + $big + $big + $big + $big + $big + $big + $big })
$limitHit = $null
for ($i = 0; $i -lt 14; $i++) {
    $r = Call POST "/api/v1/auth/login" $null @{ username = $UserA; password = "wrong-password-xx" }
    if ($r.status -eq 429) { $limitHit = $r; break }
}
Show "T11-429" "429 + Retry-After" $limitHit

# ---------- T14 边界 ----------
Show "T14-空标题" "400" (Call POST "/api/v1/documents" $tokenA @{ title = ""; content = "x" })
Show "T14-非法UUID" "400" (Call GET "/api/v1/documents/not-a-uuid" $tokenA)
Show "T14-limit=0" "400" (Call GET "/api/v1/documents?limit=0" $tokenA)
Show "T14-limit=101" "400" (Call GET "/api/v1/documents?limit=101" $tokenA)
Show "T14-offset=-1" "400" (Call GET "/api/v1/documents?offset=-1" $tokenA)
Show "T14-expected_version=0" "400" (Call PUT "/api/v1/documents/$docId" $tokenA @{ title = "t"; content = "c"; expected_version = 0 })
Show "T14-正常分页" "200" (Call GET "/api/v1/documents?limit=2&offset=0" $tokenA)

# 收尾：删除 T02/T04 探针文档
Call DELETE "/api/v1/documents/$docId`?expected_version=1" $tokenA $null | Out-Null
$v = ((Call GET "/api/v1/documents/$doc2Id" $tokenA).body | ConvertFrom-Json).version
Call DELETE "/api/v1/documents/$doc2Id`?expected_version=$v" $tokenA $null | Out-Null
"探针文档已清理"

