#!/usr/bin/env bash
# Веб-сборка «Викторин» в папку (то, что лежит на GitHub Pages и в Android-приложении):
# только файлы приложения — без tools/, docs/, release/, android/, .claude/, README и CLAUDE.md.
#   tools/build-web.sh <папка>        (папка очищается)
# Её берёт сборка APK (ornament-sort: .github/workflows/android-other.yml) и tools/android-test.js.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: tools/build-web.sh <dir>}"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$ROOT"
cp index.html config.js platform.js analytics.js playgama-bridge.js playgama-bridge-config.json "$OUT/"
for d in css js tests img; do cp -R "$d" "$OUT/$d"; done
# все скрипты и стили, на которые ссылается index.html, на месте
for f in $(grep -oE '(src|href)="[^":#]+\.(js|css|png)"' index.html | sed -E 's/^(src|href)="//; s/"$//'); do
  [ -f "$OUT/$f" ] || { echo "нет файла: $f"; exit 1; }
done
for f in js/storage.js js/sound.js js/share.js js/app.js; do [ -f "$OUT/$f" ] || { echo "нет файла: $f"; exit 1; }; done
echo "веб-сборка: $OUT ($(find "$OUT" -type f | wc -l) файлов, $(du -sh "$OUT" | cut -f1))"
