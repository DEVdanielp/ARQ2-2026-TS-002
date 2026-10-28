#!/usr/bin/env bash
# Runs once, on the first start of an empty postgres volume.
# One database + one owner per service (database-per-service, ADR-003).
# A service user can only connect to its own database.
set -euo pipefail

for db in profiles_db orders_db tracking_db query_archive_db notifications_db; do
  echo "Creating database and user: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
    CREATE USER $db WITH PASSWORD '${SERVICE_DB_PASSWORD}';
    CREATE DATABASE $db OWNER $db;
    REVOKE ALL ON DATABASE $db FROM PUBLIC;
    GRANT CONNECT ON DATABASE $db TO $db;
SQL
done
