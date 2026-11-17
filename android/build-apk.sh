#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -W)"
VERSION_CODE=$(sed -n 's/^VERSION_CODE=//p' "$ROOT/android/version.properties" | tr -d '\r')
VERSION_NAME=$(sed -n 's/^VERSION_NAME=//p' "$ROOT/android/version.properties" | tr -d '\r')
[[ "$VERSION_CODE" =~ ^[0-9]+$ && "$VERSION_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid version.properties"; exit 1; }
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

[[ "$OUT" == "$ROOT/android/build" && -f "$SRC/AndroidManifest.xml" && -f "$ROOT/package.json" ]] || { echo "Build target validation failed"; exit 1; }
rm -rf -- "$OUT"
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
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
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
  --out "red-garden-$VERSION_NAME.apk" aligned.apk
"$BT/apksigner.bat" verify --print-certs "red-garden-$VERSION_NAME.apk" | head -6
ls -la "red-garden-$VERSION_NAME.apk"
