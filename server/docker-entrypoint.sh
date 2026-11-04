#!/bin/sh
set -eu

secret_root=/tmp/license-secrets
install -d -m 0700 -o license -g license "$secret_root"

for variable in \
  JWT_SECRET_KEY_FILE CARD_HASH_SECRET_FILE CARD_ENCRYPTION_KEY_FILE \
  IDENTITY_HASH_SECRET_FILE IDENTITY_ENCRYPTION_KEY_FILE OTP_HASH_SECRET_FILE \
  REFRESH_TOKEN_SECRET_FILE CHANNEL_TOKEN_SECRET_FILE OFFLINE_SIGNING_PRIVATE_KEY_FILE \
  PROTECTED_COMPUTE_SIGNING_PRIVATE_KEY_FILE \
  PAID_TEXT_API_KEY_FILE PAID_IMAGE_API_KEY_FILE PAID_SEERFAR_API_KEY_FILE \
  API_POOL_HASH_SECRET_FILE API_POOL_ENCRYPTION_KEY_FILE \
  SMS_SECRET_KEY_FILE WECHAT_API_V3_KEY_FILE WECHAT_PRIVATE_KEY_FILE \
  WECHAT_PLATFORM_CERTIFICATE_FILE ALIPAY_APP_ID_FILE \
  ALIPAY_PRIVATE_PKCS_KEY_FILE ALIPAY_ALIPAY_PUBLIC_KEY_FILE \
  ALIPAY_PRIVATE_KEY_FILE ALIPAY_PUBLIC_KEY_FILE JEEPAY_API_KEY_FILE
do
  source_path="$(printenv "$variable" 2>/dev/null || true)"
  [ -n "$source_path" ] || continue
  file_name="$(basename "$source_path")"
  case "$file_name" in
    *[!A-Za-z0-9._-]*) echo "Invalid secret file name for $variable" >&2; exit 1 ;;
  esac
  target_path="$secret_root/$file_name"
  install -m 0400 -o license -g license "$source_path" "$target_path"
  eval "export $variable='$target_path'"
done

# BACKEND_ROLE=migrate: one-shot schema upgrade, then exit (run once per deploy so
# several API containers never race on the same migration).
if [ "${BACKEND_ROLE:-api}" = "migrate" ]; then
  exec gosu license alembic upgrade head
fi
# Single-container deployments keep upgrading on start (the previous behaviour).
if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  gosu license alembic upgrade head
fi
exec gosu license uvicorn app.main:app --host 0.0.0.0 --port 8000 \
  --workers "${BACKEND_WORKERS:-2}" \
  --timeout-keep-alive "${BACKEND_KEEP_ALIVE_SECONDS:-10}" \
  --proxy-headers --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-*}"
