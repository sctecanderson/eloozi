$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactDir = Join-Path $taskRoot 'artifacts'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null
$archivePath = Join-Path $artifactDir ('eloozi-avisos-checkout-compactos-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
# UI source snapshot includes prerequisites used by package.json. No SQL included.
# No env files, credentials, Git history, binaries, dependencies or generated build.
$folders = @('src', 'tests', 'docs/compact-ui-captures')
$explicitFiles = @(
 'scripts/package-compact-ui.ps1','scripts/preview-compact-ui.mjs','scripts/check-compact-ui-evidence.mjs',
 'supabase/functions/asaas-checkout/handler.ts','supabase/functions/asaas-webhook/handler.ts',
 'CONTINUIDADE_CODEX.md','LEIA-ME-ENTREGA.md','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html'
)
$explicitFiles += @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'docs') -File -Filter 'compact-ui-*' | ForEach-Object { 'docs/' + $_.Name })
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
if (@($orderedPaths | Where-Object { $_ -match '(^|/)(node_modules|dist)/|(^|/)\.env|\.sql$' }).Count) { throw 'Forbidden package entry' }
$manifest = foreach ($entry in $orderedPaths) {
 $digest = (Get-FileHash -LiteralPath (Join-Path $taskRoot $entry) -Algorithm SHA256).Hash.ToLowerInvariant()
 "$digest  $entry"
}
$compactFiles = @('src/features/billing/TrialBanner.tsx','src/features/billing/subscriptionNotices.ts','src/features/billing/CheckoutFinancialSummary.tsx','src/features/billing/TableCapacity.tsx','src/features/admin/SubscriptionBillingPage.tsx','tests/subscriptionNotices.test.ts','package.json')
$groupManifest = foreach ($entry in $orderedPaths) {
 $group = if ($entry -in $compactFiles) {'ui-avisos-checkout-atual'} elseif ($entry.StartsWith('supabase/functions/')) {'contexto-backend-inalterado-para-testes'} elseif ($entry -match '^(docs/|scripts/|LEIA-ME|CONTINUIDADE)') {'validacao-documentacao'} else {'contexto-preservado'}
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
