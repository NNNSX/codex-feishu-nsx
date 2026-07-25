# Feishu Credential Validation

Exchange the App ID and App Secret for a tenant access token:

```powershell
$body = @{ app_id = $appId; app_secret = $appSecret } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' -ContentType 'application/json' -Body $body
```

Validation succeeds when `code` is `0` and `tenant_access_token` is present. Never display or log the token. For Lark, use `https://open.larksuite.com`.
