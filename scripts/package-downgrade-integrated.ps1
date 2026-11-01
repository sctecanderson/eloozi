$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactDir = Join-Path $taskRoot 'artifacts'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null
$archivePath = Join-Path $artifactDir ('eloozi-validacao-integrada-downgrade-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
# Local feature snapshot includes SQL prerequisites for the disposable runner.
# Historical migrations are context only: never reapply them to an existing project.
# No env files, credentials, Git history, binaries, dependencies or generated build.
$folders = @('src', 'tests', 'supabase/migrations', 'supabase/tests', 'docs/downgrade-integrated-captures', 'public/landing/planos')
$explicitFiles = @(
 'scripts/validate-downgrade-integrated.mjs','scripts/package-downgrade-integrated.ps1','scripts/fixtures/downgrade-local-runtime.mjs','scripts/check-downgrade-integrated-evidence.mjs','scripts/fixtures/downgrade-local-clock.sql','scripts/fixtures/downgrade-integrated-browser.tsx','scripts/audit-downgrade-validation-targets.mjs','public/landing/Eloozi.png',
 'supabase/functions/asaas-checkout/handler.ts','supabase/functions/asaas-webhook/handler.ts','supabase/functions/asaas-checkout/index.ts','supabase/functions/asaas-webhook/index.ts','supabase/seeds/demo_restaurants.sql',
 'CONTINUIDADE_CODEX.md','LEIA-ME-ENTREGA.md','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html'
)
$explicitFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'docs') -File -Filter 'downgrade-integrated-*' | ForEach-Object { 'docs/' + $_.Name })
$relativePaths = [Collections.Generic.List[string]]::new()
foreach ($folder in $folders) {
 foreach ($item in Get-ChildItem -LiteralPath (Join-Path $taskRoot $folder) -File -Recurse) {
  $relativePaths.Add($item.FullName.Substring($taskRoot.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, [char]'/'))
 }
}
foreach ($entry in $explicitFiles) {
 if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $entry) -PathType Leaf)) { throw "Missing file: $entry" }
 $relativePaths.Add($entry)
}
$orderedPaths = @($relativePaths | Sort-Object -Unique)
if (@($orderedPaths | Where-Object { $_ -match '(^|/)(node_modules|dist)/|(^|/)\.env' }).Count) { throw 'Forbidden package entry' }
$manifest = foreach ($entry in $orderedPaths) {
 $digest = (Get-FileHash -LiteralPath (Join-Path $taskRoot $entry) -Algorithm SHA256).Hash.ToLowerInvariant()
 "$digest  $entry"
}
$compactFiles = @('src/features/admin/SubscriptionBillingPage.tsx','scripts/validate-downgrade-integrated.mjs','scripts/fixtures/downgrade-local-runtime.mjs','scripts/fixtures/downgrade-local-clock.sql','scripts/fixtures/downgrade-integrated-browser.tsx','scripts/audit-downgrade-validation-targets.mjs','scripts/check-downgrade-integrated-evidence.mjs')
$groupManifest = foreach ($entry in $orderedPaths) {
 $group = if ($entry -in $compactFiles) {'validacao-integrada-local'} elseif ($entry.StartsWith('supabase/migrations/')) {'migration-existente-contexto-nao-alterada'} elseif ($entry.StartsWith('public/landing/planos/')) {'assets-workspace'} elseif ($entry -in @('src/features/billing/TrialBanner.tsx','src/features/billing/subscriptionNotices.ts','src/features/billing/TableCapacity.tsx')) {'faixa-e-capacidade-preservadas'} elseif ($entry.StartsWith('supabase/functions/')) {'contexto-backend-inalterado-para-testes'} elseif ($entry -match '^(docs/|scripts/|LEIA-ME|CONTINUIDADE)') {'validacao-documentacao'} else {'contexto-preservado'}
 [ordered]@{ path=$entry; group=$group; sha256=(Get-FileHash -LiteralPath (Join-Path $taskRoot $entry) -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
 foreach ($entry in $orderedPaths) {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $taskRoot $entry), $entry) | Out-Null
 }
 $manifestEntry = $archive.CreateEntry('MANIFEST-SHA256.txt')
 $writer = [IO.StreamWriter]::new($manifestEntry.Open(), [Text.UTF8Encoding]::new($false))
 try { $writer.Write(($manifest -join "`n") + "`n") } finally { $writer.Dispose() }
 $groupEntry = $archive.CreateEntry('MANIFEST-GRUPOS.json')
 $writer = [IO.StreamWriter]::new($groupEntry.Open(), [Text.UTF8Encoding]::new($false))
 try { $writer.Write(($groupManifest | ConvertTo-Json -Depth 4)) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
$readArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
 if ($readArchive.Entries.Count -ne $orderedPaths.Count + 2) { throw 'ZIP entry count mismatch' }
 foreach ($entry in $orderedPaths) {
  $stream = $readArchive.GetEntry($entry).Open()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  $expected = (Get-FileHash -LiteralPath (Join-Path $taskRoot $entry) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "ZIP digest mismatch: $entry" }
 }
} finally { $readArchive.Dispose() }
Write-Output "ZIP verified: $archivePath"
Write-Output "Source files: $($orderedPaths.Count); SHA256: $((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash)"
