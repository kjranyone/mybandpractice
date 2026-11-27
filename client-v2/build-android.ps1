# Build libmbp_ffi.so for the v2 Android player and refresh the Kotlin bindings.
# Requires the Android NDK (this machine: %LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358)
# and the rustup targets aarch64-linux-android and x86_64-linux-android.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ndk = Join-Path $env:LOCALAPPDATA "Android\Sdk\ndk\28.2.13676358"
$bin = Join-Path $ndk "toolchains\llvm\prebuilt\windows-x86_64\bin"
if (-not (Test-Path $bin)) {
    throw "NDK clang not found at $bin"
}

$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $bin "aarch64-linux-android26-clang.cmd"
$env:CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER = Join-Path $bin "x86_64-linux-android26-clang.cmd"
$env:CC_aarch64_linux_android = $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
$env:CC_x86_64_linux_android = $env:CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER
$env:AR_aarch64_linux_android = Join-Path $bin "llvm-ar.exe"
$env:AR_x86_64_linux_android = Join-Path $bin "llvm-ar.exe"

Push-Location $root
try {
    cargo build -p mbp-ffi --release --target aarch64-linux-android
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    cargo build -p mbp-ffi --release --target x86_64-linux-android
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $jni = Join-Path $root "android\app\src\main\jniLibs"
    New-Item -ItemType Directory -Force -Path (Join-Path $jni "arm64-v8a") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $jni "x86_64") | Out-Null
    Copy-Item "target\aarch64-linux-android\release\libmbp_ffi.so" (Join-Path $jni "arm64-v8a\libmbp_ffi.so") -Force
    Copy-Item "target\x86_64-linux-android\release\libmbp_ffi.so" (Join-Path $jni "x86_64\libmbp_ffi.so") -Force

    $out = Join-Path $root "android\app\src\main\java"
    cargo run -p mbp-ffi --features bindgen --bin uniffi-bindgen -- generate --library "target\aarch64-linux-android\release\libmbp_ffi.so" --language kotlin --out-dir $out
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
