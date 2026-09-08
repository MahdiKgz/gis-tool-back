#!/bin/sh
set -eu
[ "$MINIO_APP_USER" != "$MINIO_ROOT_USER" ] || { echo "App must not use root" >&2; exit 1; }
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"
mc admin user add local "$MINIO_APP_USER" "$MINIO_APP_SECRET"
cat > /tmp/app-policy.json <<POLICY
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$S3_BUCKET/*"]}]}
POLICY
mc admin policy create local snapgis-app /tmp/app-policy.json
mc admin policy attach local snapgis-app --user "$MINIO_APP_USER"
# Only staging uploads and temporary conversion artifacts expire. Originals and healed outputs do not.
mc ilm rule import "local/$S3_BUCKET" <<'LIFECYCLE'
{"Rules":[{"ID":"temporary-artifacts","Status":"Enabled","Filter":{"Prefix":"temporary/"},"Expiration":{"Days":2}}]}
LIFECYCLE
