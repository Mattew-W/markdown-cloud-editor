# probe_api_w6_p4.ps1 —— T09 旧版本删除被拒绝（复用 p2 写出的 token）
param([string]$Base = "http://127.0.0.1:18080")
$token = (Get-Content -LiteralPath "$env:TEMP\w6_probe_token.txt" -Raw).Trim()
function Call([string]$method, [string]$path, $body) {
    $params = @{ Method = $method; Uri = "$Base$path"; SkipHttpErrorCheck = $true; Headers = @{ Authorization = "Bearer $token" }; TimeoutSec = 30 }
    if ($null -ne $body) { $params["Body"] = ($body | ConvertTo-Json -Compress); $params["ContentType"] = "application/json" }
    $r = Invoke-WebRequest @params
    [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content }
}
$doc = Call POST "/api/v1/documents" @{ title = "T09 旧版本删除"; content = "v1" }
$id = ($doc.body | ConvertFrom-Json).id
"T09-创建: status=$($doc.status) id=$id"
$up = Call PUT "/api/v1/documents/$id" @{ title = "T09 旧版本删除"; content = "v2"; expected_version = 1 }
"T09-更新到v2: status=$($up.status) body=$($up.body)"
$del1 = Call DELETE "/api/v1/documents/$id`?expected_version=1"
"T09-旧版本删除(expected_version=1): status=$($del1.status) body=$($del1.body)"
$still = Call GET "/api/v1/documents/$id"
"T09-删除被拒后仍可读: status=$($still.status) version=$((($still.body | ConvertFrom-Json).version))"
$del2 = Call DELETE "/api/v1/documents/$id`?expected_version=2"
"T09-当前版本删除(expected_version=2): status=$($del2.status) bodyLen=$($del2.body.Length)"
$after = Call GET "/api/v1/documents/$id"
"T09-删除后读取: status=$($after.status) body=$($after.body)"

