#!/usr/bin/env bash
set -euo pipefail
ROOT="D:/Documents/Codex/2026-11-10/new-chat/work/github-pages"
TC="$ROOT/android/toolchain"
JDK="$TC/jdk-17.0.2"
BT="$TC/android-15"
PLATFORM="$TC/android-35/android.jar"
SRC="$ROOT/android/app/src/main"
SITE="$ROOT/dist"
npm --prefix "$ROOT" run build
OUT="$ROOT/android/build"
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "1/6 aapt2 compile"
"$BT/aapt2.exe" compile --dir "$SRC/res" -o "$OUT/res/resources.zip"

echo "2/6 aapt2 link (assets from dist/)"
"$BT/aapt2.exe" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" \
  -A "$SITE" \
  --java "$OUT/gen" \
  --min-sdk-version 23 \
  --target-sdk-version 35 \
  --version-code 11 \
  --version-name 1.1.9 \
  "$OUT/res/resources.zip"

echo "3/6 javac"
find "$SRC/java" "$OUT/gen" -name "*.java" > "$OUT/sources.txt"
# Lambdas need LambdaMetafactory, which android.jar does not ship; build-tools
# provides core-lambda-stubs.jar for exactly this.
"$JDK/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$PLATFORM;$BT/core-lambda-stubs.jar" \
  -d "$OUT/classes" @"$OUT/sources.txt" 2> "$OUT/javac.err" || { cat "$OUT/javac.err"; exit 1; }

echo "4/6 d8"
CLASS_COUNT=$(find "$OUT/classes" -name "*.class" | wc -l)
[ "$CLASS_COUNT" -gt 0 ] || { echo "javac 没有产出 class"; exit 1; }
find "$OUT/classes" -name "*.class" > "$OUT/classes.txt"
"$BT/d8.bat" --lib "$PLATFORM" --min-api 23 --release --output "$OUT/dex" @"$OUT/classes.txt" > /dev/null

echo "5/6 add classes.dex"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
cd "$OUT"
"$JDK/bin/jar.exe" uf unsigned.apk -C "$OUT/dex" classes.dex

echo "6/6 zipalign + sign"
"$BT/zipalign.exe" -f -p 4 unsigned.apk aligned.apk
"$BT/apksigner.bat" sign \
  --ks "$ROOT/android/manual-build/debug.keystore" \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out red-garden-1.1.9.apk aligned.apk
"$BT/apksigner.bat" verify --print-certs red-garden-1.1.9.apk | head -6
ls -la red-garden-1.1.9.apk
