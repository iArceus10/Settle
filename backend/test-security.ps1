$ErrorActionPreference = "Stop"
$Base = "http://localhost:3001"
$Pass = 0
$Fail = 0

function Test-Case($name, $condition) {
  if ($condition) {
    Write-Host "[PASS] $name" -ForegroundColor Green
    $script:Pass++
  } else {
    Write-Host "[FAIL] $name" -ForegroundColor Red
    $script:Fail++
  }
}

function Invoke-Api($Method, $Path, $Body = $null, $Token = $null) {
  $headers = @{ "Content-Type" = "application/json" }
  if ($Token) { $headers["Authorization"] = "Bearer $Token" }
  $params = @{
    Uri = "$Base$Path"
    Method = $Method
    Headers = $headers
    UseBasicParsing = $true
  }
  if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
  try {
    $resp = Invoke-WebRequest @params
    return @{ Status = $resp.StatusCode; Body = ($resp.Content | ConvertFrom-Json) }
  } catch {
    if (-not $_.Exception.Response) {
      return @{ Status = 0; Body = $null; Raw = $_.Exception.Message }
    }

    $status = $_.Exception.Response.StatusCode.value__
    $text = ""

    if ($_.Exception.Response.PSObject.Properties.Name -contains "Content") {
      $text = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } else {
      $stream = $_.Exception.Response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $text = $reader.ReadToEnd()
    }

    $body = $null
    try { $body = $text | ConvertFrom-Json } catch {}
    return @{ Status = $status; Body = $body; Raw = $text }
  }
}

Write-Host "`n=== Settle Security Test Suite ===`n" -ForegroundColor Cyan

# Health
$h = Invoke-Api GET "/health"
Test-Case "Health check" ($h.Status -eq 200)
if ($h.Status -eq 0) {
  Write-Host "`nBackend is not reachable at $Base. Start it in another terminal first:" -ForegroundColor Yellow
  Write-Host "cd /d/projects/Settle/backend"
  Write-Host "npm run dev`n"
  exit 1
}

# Sign up two users
$suffix = [guid]::NewGuid().ToString().Substring(0, 8)
$userA = Invoke-Api POST "/auth/signup" @{ email = "alice_$suffix@test.com"; password = "secret12" }
$userB = Invoke-Api POST "/auth/signup" @{ email = "bob_$suffix@test.com"; password = "secret12" }
Test-Case "User A signup" ($userA.Status -eq 201 -and $userA.Body.token)
Test-Case "User B signup" ($userB.Status -eq 201 -and $userB.Body.token)
$tokenA = $userA.Body.token
$tokenB = $userB.Body.token

# User A creates group
$group = Invoke-Api POST "/groups" @{ name = "Test Group $suffix" } $tokenA
Test-Case "Create group" ($group.Status -eq 200 -and $group.Body.id)
$groupId = $group.Body.id

# User B cannot read balances without joining
$balNoMember = Invoke-Api GET "/groups/$groupId/balances" $null $tokenB
Test-Case "Balances blocked for non-member (403)" ($balNoMember.Status -eq 403)

$setNoMember = Invoke-Api GET "/groups/$groupId/settlements" $null $tokenB
Test-Case "Settlements blocked for non-member (403)" ($setNoMember.Status -eq 403)

# User A joins group
$memberA = Invoke-Api POST "/groups/$groupId/members" @{ name = "Alice"; user_id = $userA.Body.user.id } $tokenA
Test-Case "User A joins group" ($memberA.Status -eq 200)
$memberAId = $memberA.Body.id

# User B joins group
$memberB = Invoke-Api POST "/groups/$groupId/members" @{ name = "Bob"; user_id = $userB.Body.user.id } $tokenB
Test-Case "User B joins group" ($memberB.Status -eq 200)
$memberBId = $memberB.Body.id

# User B can now read balances
$balMember = Invoke-Api GET "/groups/$groupId/balances" $null $tokenB
Test-Case "Balances allowed for member (200)" ($balMember.Status -eq 200)

# Create expense with payer from wrong group (fake member id)
$fakeMemberId = [guid]::NewGuid().ToString()
$badExpense = Invoke-Api POST "/groups/$groupId/expenses" @{
  id = [guid]::NewGuid().ToString()
  paid_by = $fakeMemberId
  amount = 100
  description = "Bad payer"
  splits = @(@{ member_id = $memberAId; share = 50 }, @{ member_id = $memberBId; share = 50 })
} $tokenA
Test-Case "Expense rejected: payer not in group (400)" ($badExpense.Status -eq 400)

# Valid expense
$expId = [guid]::NewGuid().ToString()
$goodExpense = Invoke-Api POST "/groups/$groupId/expenses" @{
  id = $expId
  paid_by = $memberAId
  amount = 100
  description = "Dinner"
  splits = @(@{ member_id = $memberAId; share = 50 }, @{ member_id = $memberBId; share = 50 })
} $tokenA
Test-Case "Valid expense created (200)" ($goodExpense.Status -eq 200)

# User A tries to confirm on behalf of User B
$spoofConfirm = Invoke-Api POST "/expenses/$expId/confirm" @{ member_id = $memberBId } $tokenA
Test-Case "Confirm spoof blocked (403)" ($spoofConfirm.Status -eq 403)

# User B confirms for themselves
$selfConfirm = Invoke-Api POST "/expenses/$expId/confirm" @{ member_id = $memberBId } $tokenB
Test-Case "Self confirm allowed (200)" ($selfConfirm.Status -eq 200)

# Confirm for non-existent expense
$badExpConfirm = Invoke-Api POST "/expenses/$([guid]::NewGuid())/confirm" @{ member_id = $memberBId } $tokenB
Test-Case "Confirm on missing expense (404)" ($badExpConfirm.Status -eq 404)

# Auto-confirm must belong to creator, not payer
$payerOtherExpId = [guid]::NewGuid().ToString()
$payerOtherExpense = Invoke-Api POST "/groups/$groupId/expenses" @{
  id = $payerOtherExpId
  paid_by = $memberBId
  amount = 30
  description = "Alice entered Bob paid"
  splits = @(@{ member_id = $memberAId; share = 15 }, @{ member_id = $memberBId; share = 15 })
} $tokenA
Test-Case "Expense with another payer created (200)" ($payerOtherExpense.Status -eq 200)
$expensesAfterOtherPayer = Invoke-Api GET "/groups/$groupId/expenses" $null $tokenA
$otherPayerExpense = @($expensesAfterOtherPayer.Body | Where-Object { $_.id -eq $payerOtherExpId })[0]
$creatorConf = @($otherPayerExpense.confirmations | Where-Object { $_.member_id -eq $memberAId } | Sort-Object created_at -Descending)[0]
$payerConf = @($otherPayerExpense.confirmations | Where-Object { $_.member_id -eq $memberBId } | Sort-Object created_at -Descending)[0]
Test-Case "Creator auto-confirmed" ($creatorConf.status -eq "confirmed")
Test-Case "Different payer remains pending" ($payerConf.status -eq "pending")

# Sync confirmation spoof must be ignored
$spoofSync = Invoke-Api POST "/groups/$groupId/sync" @{
  local_expenses = @()
  local_confirmations = @(@{
    id = [guid]::NewGuid().ToString()
    expense_id = $payerOtherExpId
    member_id = $memberBId
    status = "disputed"
    created_at = (Get-Date).ToUniversalTime().ToString("o")
  })
} $tokenA
Test-Case "Sync spoof request does not fail whole sync (200)" ($spoofSync.Status -eq 200)
$expensesAfterSpoofSync = Invoke-Api GET "/groups/$groupId/expenses" $null $tokenA
$spoofTargetExpense = @($expensesAfterSpoofSync.Body | Where-Object { $_.id -eq $payerOtherExpId })[0]
$latestPayerConf = @($spoofTargetExpense.confirmations | Where-Object { $_.member_id -eq $memberBId } | Sort-Object created_at -Descending)[0]
Test-Case "Sync spoof did not create forged confirmation" ($latestPayerConf.status -eq "pending")

# Sync with invalid payer
$badSync = Invoke-Api POST "/groups/$groupId/sync" @{
  local_expenses = @(@{
    id = [guid]::NewGuid().ToString()
    paid_by = $fakeMemberId
    amount = 50
    description = "Bad sync expense"
    created_at = (Get-Date).ToUniversalTime().ToString("o")
    splits = @(@{ member_id = $memberAId; share = 25 }, @{ member_id = $memberBId; share = 25 })
  })
  local_confirmations = @()
} $tokenA
Test-Case "Sync rejects invalid payer (400)" ($badSync.Status -eq 400)

Write-Host "`n=== Results: $Pass passed, $Fail failed ===`n" -ForegroundColor Cyan
if ($Fail -gt 0) { exit 1 }
