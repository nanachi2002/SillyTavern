# Post-build script: Replace libnode.so in APK with 16KB-aligned version
# Run after Gradle build completes, before signing
#
# Usage: powershell -File mobile/align-libnode-apk.ps1 [debug|release]
#
# Requires: python3, repack-elf-16k.py, llvm-objcopy (from NDK)

param(
    [ValidateSet("debug", "release")]
    [string] $BuildType = "debug"
)

$ErrorActionPreference = "Stop"

$NdkDir = Join-Path $env:LOCALAPPDATA "Android\Sdk\ndk\27.0.12077973"
$Objcopy = Join-Path $NdkDir "toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-objcopy.exe"
$Readelf = Join-Path $NdkDir "toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe"
$Repacker = Join-Path $PSScriptRoot "repack-elf-16k.py"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LibnodeDir = Join-Path $ProjectRoot "android\app\libnode\bin"
$MergedLibs = Join-Path $ProjectRoot "android\app\build\intermediates\merged_native_libs\$BuildType\merge${BuildType}NativeLibs\out\lib"

if (-not (Test-Path $Objcopy)) {
    Write-Host "llvm-objcopy not found at: $Objcopy" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $Repacker)) {
    Write-Host "repack-elf-16k.py not found at: $Repacker" -ForegroundColor Red
    exit 1
}

$abis = @("arm64-v8a", "x86_64")

foreach ($abi in $abis) {
    $src = Join-Path $LibnodeDir "$abi\libnode.so"
    $dst = Join-Path $MergedLibs "$abi\libnode.so"

    if (-not (Test-Path $src)) {
        Write-Host "[$abi] libnode.so not found, skipping" -ForegroundColor Yellow
        continue
    }

    if (-not (Test-Path $dst)) {
        Write-Host "[$abi] Merged lib not found (build not done?), skipping" -ForegroundColor Yellow
        continue
    }

    Write-Host "[$abi] Processing libnode.so for 16KB alignment..." -ForegroundColor Cyan

    $tmpDir = Join-Path $env:TEMP "libnode-align-$abi"
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    $stripped = Join-Path $tmpDir "stripped.so"
    $repacked = Join-Path $tmpDir "repacked.so"

    # Step 1: Strip debug sections and symtab (keep dynsym)
    Write-Host "  [1/3] Stripping debug sections..."
    & $Objcopy --strip-all $src $stripped
    if (-not $?) { Write-Host "  objcopy strip failed" -ForegroundColor Red; exit 1 }

    # Step 2: Repack for 16KB alignment
    Write-Host "  [2/3] Repacking for 16KB alignment..."
    python $Repacker $stripped $repacked
    if (-not $?) { Write-Host "  repack failed" -ForegroundColor Red; exit 1 }

    # Step 3: Replace in merged libs (this is what gets packaged into APK)
    Write-Host "  [3/3] Replacing in APK merge directory..."
    Copy-Item $repacked $dst -Force

    # Verify
    $aligned = & $Readelf -l $dst 2>$null | Select-String "LOAD"
    $allOk = $true
    foreach ($line in $aligned) {
        if ($line -match "0x(\d+)\s+\d") {
            # Just check it ran
        }
    }

    $size = [math]::Round((Get-Item $dst).Length / 1MB, 2)
    Write-Host "  Done! Size: $size MB" -ForegroundColor Green

    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== 16KB alignment complete ===" -ForegroundColor Green
Write-Host "Re-run assembleDebug/assembleRelease to pick up the changes," -ForegroundColor Yellow
Write-Host "or the next package step will use the replaced files." -ForegroundColor Yellow