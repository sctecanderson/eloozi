[CmdletBinding()]
param([switch]$WhatIf)
$ErrorActionPreference='Stop'
$expected=@{
 '04d9a961-d892-445e-8dbb-8a660c676ab8'='Eloozi restore outbound block 04d9a961-d892-445e-8dbb-8a660c676ab8'
 '5001837a-d478-4e8a-b6b8-8165e961206c'='Eloozi restore outbound block 5001837a-d478-4e8a-b6b8-8165e961206c'
 'fbd5bc3d-cd5d-481b-8812-57284b0bd329'='Eloozi restore outbound block fbd5bc3d-cd5d-481b-8812-57284b0bd329'
 '35af0bbf-0012-4bb0-8c4d-cc2fe328c7ee'='Eloozi restore outbound block 35af0bbf-0012-4bb0-8c4d-cc2fe328c7ee'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if(-not $WhatIf -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Abra PowerShell como Administrador.'}
$fw=New-Object -ComObject HNetCfg.FwPolicy2
$verified=@()
foreach($id in $expected.Keys){
 $r=@($fw.Rules | Where-Object Name -eq $expected[$id])
 if($r.Count -ne 1){throw "RunId $id ausente ou duplicado; nenhuma regra foi removida."}
 $rule=$r[0]
 $expectedGroup="Eloozi restore containment $id"
 if($rule.Grouping -ne $expectedGroup -or -not [string]::IsNullOrEmpty([string]$rule.Description) -or [IO.Path]::GetFullPath($rule.ApplicationName) -ne 'D:\pgSQL\bin\postgres.exe' -or -not $rule.Enabled -or $rule.Direction -ne 2 -or $rule.Action -ne 0 -or $rule.Protocol -ne 256 -or $rule.RemoteAddresses -ne '*'){
   throw "RunId $id metadata diverge; nenhuma regra foi removida."
 }
 $verified += $rule
}
if($WhatIf){$verified | ForEach-Object { 'Would remove exact rule: '+$_.Name }; exit 0}
foreach($r in $verified){$fw.Rules.Remove($r.Name); 'Removed exact rule: '+$r.Name}
