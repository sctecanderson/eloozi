$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactDir = Join-Path $taskRoot 'artifacts'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null
$archivePath = Join-Path $artifactDir ('eloozi-bloqueios-contratuais-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
# Source snapshot includes prerequisites used by package.json and local migrations.
# No env files, credentials, Git history, binaries, dependencies or generated build.
$folders = @('src', 'tests', 'supabase/migrations')
$explicitFiles = @(
 'scripts/package-contract-modules.ps1', 'scripts/test-contract-modules-db.mjs',
 'supabase/tests/contract_modules_test.sql', 'supabase/tests/contract_modules_sale_regression.sql', 'supabase/tests/basic_manual_delivery_test.sql',
 'supabase/functions/asaas-checkout/handler.ts', 'supabase/functions/asaas-webhook/handler.ts',
 'docs/contract-modules-relatorio.md', 'docs/contract-modules-sql.log', 'docs/contract-modules-runner-output.log',
 'docs/contract-modules-typecheck.log', 'docs/contract-modules-build.log', 'docs/contract-modules-node.log',
 'LEIA-ME-ENTREGA.md', 'CONTINUIDADE_CODEX.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html',
 'supabase/tests/etapa3_bootstrap.sql', 'supabase/tests/contact_channels_test.sql', 'supabase/seeds/demo_restaurants.sql',
 'scripts/test-contact-channels-db.mjs', 'scripts/preview-contact-channels.mjs', 'scripts/preview-contrast.mjs',
 'scripts/check-rendered-contrast.mjs', 'scripts/check-nav-contacts-contrast.mjs', 'scripts/package-nav-contacts.ps1',
 'docs/nav-contacts-relatorio.md', 'docs/contacts-sql-resultados.log', 'docs/nav-contacts-node.log',
 'docs/nav-contacts-typecheck.log', 'docs/nav-contacts-build.log', 'docs/nav-contacts-ratios.log',
 'docs/nav-contacts-measurements-dark.json', 'docs/nav-contacts-measurements-light.json',
 'docs/nav-browser-state.json', 'docs/contacts-browser-state.json',
 'docs/contrast-before.css', 'docs/contrast-relatorio.md', 'docs/contrast-ratios.log',
 'docs/contrast-typecheck.log', 'docs/contrast-build.log', 'docs/contrast-integridade.txt',
 'docs/contrast-measurements-dark.json', 'docs/contrast-measurements-light.json', 'docs/contrast-browser-state.json',
 'docs/contrast-captures/before-dark-mobile.jpg', 'docs/contrast-captures/before-light-mobile.jpg',
 'docs/contrast-captures/before-dark-mobile-modal.jpg', 'docs/contrast-captures/after-dark-mobile.jpg',
 'docs/contrast-captures/after-light-mobile.jpg', 'docs/contrast-captures/after-dark-mobile-modal.jpg',
 'docs/contrast-captures/after-dark-mobile-menu.jpg', 'docs/contrast-captures/after-dark-mobile-form.jpg',
 'docs/contrast-captures/after-dark-desktop-full.jpg', 'docs/contrast-captures/after-light-desktop-full.jpg',
 'docs/contrast-captures/nav-atendimento-dark.jpg', 'docs/contrast-captures/nav-atendimento-light.jpg',
 'docs/contrast-captures/nav-comandas-dark.jpg', 'docs/contrast-captures/nav-comandas-light.jpg',
 'docs/contrast-captures/nav-comandas-dark-desktop.jpg', 'docs/contrast-captures/nav-comandas-light-desktop.jpg',
 'docs/contrast-captures/contacts-dark-mobile-final.jpg', 'docs/contrast-captures/contacts-light-mobile-final.jpg',
 'docs/contrast-captures/contacts-dark-desktop-final.jpg', 'docs/contrast-captures/contacts-light-desktop-final.jpg',
 'docs/contrast-captures/contacts-public-all-on.jpg', 'docs/contrast-captures/contacts-public-instagram-off.jpg'
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
$contractFiles = @('src/features/restaurants/ModuleAccess.tsx','src/features/restaurants/moduleAccessService.ts','src/features/admin/AdminOverview.tsx','src/features/admin/CatalogEditor.tsx','src/app/App.tsx','supabase/migrations/20261029024000_contract_module_access.sql','tests/moduleAccess.test.ts')
$navFiles = @('src/app/App.tsx','src/styles.css','src/features/theme/brandContrast.ts')
$contactFiles = @('src/features/admin/IdentityPage.tsx','src/features/admin/restaurantAdmin.ts','src/features/restaurants/RestaurantProvider.tsx','src/features/restaurants/contactChannels.ts','src/features/menu/HomePage.tsx','supabase/migrations/20261029010637_restaurant_contact_channels.sql')
$priorFiles = @('src/features/service/StaffServicePage.tsx','src/features/service/ComandasPage.tsx','src/features/service/ChamadosPage.tsx','src/features/service/StaffHistoryPage.tsx','src/features/service/TableTabsPanel.tsx','src/features/service/TableDetailsTabPanel.tsx')
$groupManifest = foreach ($entry in $orderedPaths) {
 $group = if ($entry -in $contractFiles) {'bloqueios-contratuais'} elseif ($entry -in $navFiles) {'menu-garcom-ou-estilo-compartilhado'} elseif ($entry -in $contactFiles) {'canais-de-contato'} elseif ($entry -in $priorFiles) {'contraste-anterior'} elseif ($entry -match '^(docs/|scripts/|LEIA-ME|CONTINUIDADE)' -or $entry -eq 'tests/contactChannels.test.ts' -or $entry -eq 'supabase/tests/contact_channels_test.sql' -or $entry -eq 'package.json') {'validacao-documentacao'} else {'contexto-local-preservado'}
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
