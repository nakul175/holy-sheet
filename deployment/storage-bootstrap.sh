#!/bin/sh
set -eu
attempt=0
until mc alias set staging http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo 'Private storage did not become ready' >&2; exit 1; fi
  sleep 2
done
mc mb --ignore-existing staging/holy-sheet >/dev/null
mc anonymous set none staging/holy-sheet >/dev/null
mc admin user add staging "$HS_STORAGE_ACCESS_KEY" "$HS_STORAGE_SECRET_KEY" >/dev/null
mc admin policy create staging hs-media /media-policy.json >/dev/null
mc admin policy attach staging hs-media --user "$HS_STORAGE_ACCESS_KEY" >/dev/null
echo 'Private media bucket and scoped service account prepared'
