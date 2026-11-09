#!/bin/sh
set -eu
umask 077
backup_dir=/opt/trinitymatrix/backups
mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cd /opt/trinitymatrix/current
docker compose --env-file /opt/trinitymatrix/shared/runtime.env \
    -f deploy/single-server/compose.yml exec -T postgres \
    pg_dump -U trinitymatrix -d trinitymatrix -Fc > "$backup_dir/postgres-$stamp.dump.partial"
mv "$backup_dir/postgres-$stamp.dump.partial" "$backup_dir/postgres-$stamp.dump"
printf '%s\n' "PostgreSQL backup completed: $backup_dir/postgres-$stamp.dump"
