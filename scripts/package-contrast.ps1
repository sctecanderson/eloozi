$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactDir = Join-Path $taskRoot 'artifacts'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null
$archivePath = Join-Path $artifactDir ('contrast-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
# Source snapshot includes prerequisites used by package.json and local migrations.
# No env files, credentials, Git history, binaries, dependencies or generated build.
$folders = @()
$explicitFiles = @(
 'src/styles.css', 'src/app/App.tsx',
 'src/features/service/StaffServicePage.tsx', 'src/features/service/ComandasPage.tsx',
 'src/features/service/ChamadosPage.tsx', 'src/features/service/StaffHistoryPage.tsx',
 'src/features/service/TableTabsPanel.tsx', 'src/features/service/TableDetailsTabPanel.tsx',
 'scripts/preview-contrast.mjs', 'scripts/check-rendered-contrast.mjs', 'scripts/package-contrast.ps1',
 'docs/contrast-before.css', 'docs/contrast-relatorio.md', 'docs/contrast-ratios.log',
 'docs/contrast-typecheck.log', 'docs/contrast-build.log', 'docs/contrast-integridade.txt',
 'docs/contrast-measurements-dark.json', 'docs/contrast-measurements-light.json',
 'docs/contrast-browser-state.json', 'CONTINUIDADE_CODEX.md',
 'docs/contrast-captures/before-dark-mobile.jpg', 'docs/contrast-captures/before-light-mobile.jpg',
 'docs/contrast-captures/before-dark-mobile-modal.jpg',
 'docs/contrast-captures/after-dark-mobile.jpg', 'docs/contrast-captures/after-light-mobile.jpg',
 'docs/contrast-captures/after-dark-mobile-modal.jpg', 'docs/contrast-captures/after-dark-mobile-menu.jpg',
 'docs/contrast-captures/after-dark-mobile-form.jpg',
 'docs/contrast-captures/after-dark-desktop-full.jpg', 'docs/contrast-captures/after-light-desktop-full.jpg'
)
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
