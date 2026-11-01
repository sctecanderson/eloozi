$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactDir = Join-Path $taskRoot 'artifacts'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null
$archivePath = Join-Path $artifactDir ('no-kds-review-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
# Source snapshot includes prerequisites used by package.json and local migrations.
# No env files, credentials, Git history, binaries, dependencies or generated build.
$folders = @('src', 'supabase/migrations', 'supabase/seeds')
$explicitFiles = @(
 'CONTINUIDADE_CODEX.md', 'docs/no-kds-relatorio.md', 'docs/no-kds-sql-resultados.log',
 'docs/no-kds-node-resultados.log', 'docs/no-kds-fontes-antes.sha256',
 'docs/no-kds-fontes-depois.sha256', 'docs/no-kds-integridade.txt',
 'scripts/test-no-kds-db.mjs', 'scripts/package-no-kds-review.ps1',
 'supabase/tests/no_kds_operational_test.sql', 'supabase/tests/etapa3_bootstrap.sql',
 'tests/chamados.test.ts', 'tests/tableTabsClosing.test.ts', 'tests/test_loader.mjs',
 'package.json', 'package-lock.json', 'tsconfig.json'
)
$relativePaths = [Collections.Generic.List[string]]::new()
foreach ($folder in $folders) {
 foreach ($item in Get-ChildItem -LiteralPath (Join-Path $taskRoot $folder) -File -Recurse) {
  if ($folder -eq 'supabase/migrations' -and [string]::CompareOrdinal($item.Name, '20261028223000_commercial_catalog_modules_and_active_tables_quota.sql') -gt 0) { continue }
  $relativePaths.Add($item.FullName.Substring($taskRoot.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, [char]'/'))
 }
}
foreach ($entry in $explicitFiles) {
 if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $entry) -PathType Leaf)) { throw "Missing file: $entry" }
 $relativePaths.Add($entry)
}
$orderedPaths = @($relativePaths | Sort-Object -Unique)
$manifest = foreach ($entry in $orderedPaths) {
 $digest = (Get-FileHash -LiteralPath (Join-Path $taskRoot $entry) -Algorithm SHA256).Hash.ToLowerInvariant()
 "$digest  $entry"
}
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
 foreach ($entry in $orderedPaths) {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $taskRoot $entry), $entry) | Out-Null
 }
 $manifestEntry = $archive.CreateEntry('MANIFEST-SHA256.txt')
 $writer = [IO.StreamWriter]::new($manifestEntry.Open(), [Text.UTF8Encoding]::new($false))
 try { $writer.Write(($manifest -join "`n") + "`n") } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
$readArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
 if ($readArchive.Entries.Count -ne $orderedPaths.Count + 1) { throw 'ZIP entry count mismatch' }
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
