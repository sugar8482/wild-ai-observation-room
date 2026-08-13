#!/usr/bin/env bash
set -euo pipefail

app_dir="${1:-/root/wild-ai-observation-room}"
env_file="${app_dir}/.env.local"
db_name="wild_observation_archive"
db_user="wild_observation_archive_user"
db_password="$(openssl rand -hex 24)"

if [[ ! -d "${app_dir}" ]]; then
  echo "Application directory does not exist: ${app_dir}" >&2
  exit 1
fi

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${db_user}'" | grep -qx 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE ${db_user} WITH LOGIN PASSWORD '${db_password}'" >/dev/null
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE ${db_user} WITH LOGIN PASSWORD '${db_password}'" >/dev/null
fi

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db_name}'" | grep -qx 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE ${db_name} OWNER TO ${db_user}" >/dev/null
else
  sudo -u postgres createdb --owner="${db_user}" "${db_name}"
fi

touch "${env_file}"
chmod 600 "${env_file}"
if [[ ! -e "${env_file}.before-postgres-archive" ]]; then
  cp "${env_file}" "${env_file}.before-postgres-archive"
fi

temp_env="$(mktemp)"
grep -vE '^OBSERVATION_DATABASE_(URL|SSL)=' "${env_file}" > "${temp_env}" || true
printf '%s\n' \
  "OBSERVATION_DATABASE_URL=postgresql://${db_user}:${db_password}@127.0.0.1:5432/${db_name}" \
  "OBSERVATION_DATABASE_SSL=false" >> "${temp_env}"
install -m 600 "${temp_env}" "${env_file}"
rm -f "${temp_env}"

echo "POSTGRES_ARCHIVE_READY database=${db_name} user=${db_user}"
