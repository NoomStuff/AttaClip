param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$runtime = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $runtime 'avcodec-62.dll'))) { throw 'Missing staged OBS FFmpeg DLL.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AttaClipObsSourceProbe {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetDllDirectory(string path);
[DllImport("avcodec-62.dll", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr avcodec_configuration();
[DllImport("avcodec-62.dll", CallingConvention=CallingConvention.Cdecl)] public static extern uint avcodec_version();
}
'@
if (![AttaClipObsSourceProbe]::SetDllDirectory($runtime)) { throw 'Could not select staged OBS library directory.' }
$probeHasher = [Security.Cryptography.SHA256]::Create()
$probeStream = [IO.File]::OpenRead((Join-Path $runtime 'avcodec-62.dll'))
try { $probeDigest = [BitConverter]::ToString($probeHasher.ComputeHash($probeStream)).Replace('-', '').ToLowerInvariant() }
finally { $probeStream.Dispose(); $probeHasher.Dispose() }
$result = [ordered]@{
  file = 'avcodec-62.dll'
  sha256 = $probeDigest
  version = [AttaClipObsSourceProbe]::avcodec_version()
  configuration = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([AttaClipObsSourceProbe]::avcodec_configuration())
}
$result | ConvertTo-Json -Depth 4
