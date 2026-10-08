param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$runtime = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $runtime 'avcodec-62.dll'))) { throw 'Missing staged OBS FFmpeg DLL.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AttaClipObsSourceProbe {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetDllDirectory(string path);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetModuleFileName(IntPtr module, StringBuilder name, int length);
[DllImport("avcodec-62.dll", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr avcodec_configuration();
[DllImport("avcodec-62.dll", CallingConvention=CallingConvention.Cdecl)] public static extern uint avcodec_version();
[DllImport("avutil-60.dll", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr av_version_info();
[DllImport("libcurl.dll", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr curl_version();
[DllImport("zlib.dll", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr zlibVersion();
[DllImport("srt.dll", CallingConvention=CallingConvention.Cdecl)] public static extern uint srt_getversion();
[DllImport("librist.dll", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr librist_version();
}
'@
if (![AttaClipObsSourceProbe]::SetDllDirectory($runtime)) { throw 'Could not select staged OBS library directory.' }
function Read-StagedLibrary([string]$name) {
  $expected = Join-Path $runtime $name
  $module = [AttaClipObsSourceProbe]::LoadLibraryEx($expected, [IntPtr]::Zero, 0x1100)
  if ($module -eq [IntPtr]::Zero) { throw "Could not load staged library $name." }
  $buffer = New-Object Text.StringBuilder 32768
  if ([AttaClipObsSourceProbe]::GetModuleFileName($module, $buffer, $buffer.Capacity) -eq 0) { throw "Cannot identify loaded library $name." }
  if (![string]::Equals($buffer.ToString(), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw "Loaded $name outside the staged runtime." }
  $probeHasher = [Security.Cryptography.SHA256]::Create()
  $probeStream = [IO.File]::OpenRead($expected)
  try { $digest = [BitConverter]::ToString($probeHasher.ComputeHash($probeStream)).Replace('-', '').ToLowerInvariant() }
  finally { $probeStream.Dispose(); $probeHasher.Dispose() }
  return [ordered]@{ file = $name; sha256 = $digest }
}
$libraries = @('avcodec-62.dll', 'libcurl.dll', 'zlib.dll', 'srt.dll', 'librist.dll', 'libx264-164.dll', 'avutil-60.dll') | ForEach-Object { Read-StagedLibrary $_ }
$libraries[1].version = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([AttaClipObsSourceProbe]::curl_version())
$libraries[2].version = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([AttaClipObsSourceProbe]::zlibVersion())
$srtVersion = [AttaClipObsSourceProbe]::srt_getversion()
$libraries[3].version = '{0}.{1}.{2}' -f (($srtVersion -shr 16) -band 255), (($srtVersion -shr 8) -band 255), ($srtVersion -band 255)
$libraries[4].version = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([AttaClipObsSourceProbe]::librist_version())
$x264Bytes = [IO.File]::ReadAllBytes((Join-Path $runtime 'libx264-164.dll'))
$x264Text = [Text.Encoding]::GetEncoding(28591).GetString($x264Bytes)
$x264Match = [regex]::Match($x264Text, ' r(\d+) ([a-f0-9]{7})\x00')
if (!$x264Match.Success) { throw 'Cannot read staged x264 build identity.' }
$libraries[5].version = 'r' + $x264Match.Groups[1].Value
$libraries[5].commitPrefix = $x264Match.Groups[2].Value
$libraries[6].version = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([AttaClipObsSourceProbe]::av_version_info())
$result = [ordered]@{
  file = 'avcodec-62.dll'
  sha256 = $libraries[0].sha256
  version = [AttaClipObsSourceProbe]::avcodec_version()
  configuration = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([AttaClipObsSourceProbe]::avcodec_configuration())
  libraries = $libraries
}
$result | ConvertTo-Json -Depth 4
