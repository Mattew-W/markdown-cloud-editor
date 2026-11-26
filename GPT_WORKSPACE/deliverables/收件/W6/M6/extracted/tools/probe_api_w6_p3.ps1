# probe_api_w6_p3.ps1 —— 停库窗口内的 5xx 探针（读 p2 写出的 token）
param([string]$Base = "http://127.0.0.1:18080")
$token = (Get-Content -LiteralPath "$env:TEMP\w6_probe_token.txt" -Raw).Trim()
$h = @{ Authorization = "Bearer $token" }
foreach ($p in @("/api/v1/documents", "/health")) {
    try {
        $r = Invoke-WebRequest -Uri "$Base$p" -Headers $h -SkipHttpErrorCheck -TimeoutSec 20
        "[5xx] $p -> status=$([int]$r.StatusCode) body=$($r.Content)"
    } catch {
        "[5xx] $p -> 异常 $($_.Exception.Message)"
    }
}

