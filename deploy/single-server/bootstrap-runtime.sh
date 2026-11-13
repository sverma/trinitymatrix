#!/bin/sh
set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_dir=${1:-/opt/trinitymatrix/shared}
env_file="$runtime_dir/runtime.env"
tls_dir="$runtime_dir/postgres-tls"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
if [ ! -f "$env_file" ]; then
    cp "$script_dir/runtime.env.example" "$env_file"
fi
chmod 600 "$env_file"
replace_value() {
    temporary_file=$(mktemp "$runtime_dir/.env.XXXXXX")
    sed "s|^${1}=.*|${1}=${2}|" "$env_file" > "$temporary_file"
    chmod 600 "$temporary_file"
    mv "$temporary_file" "$env_file"
}
generate_value() {
    if grep -q "^${1}=GENERATE_WITH_BOOTSTRAP$" "$env_file"; then
        replace_value "$1" "$2"
    fi
}
replace_value TRINITY_RUNTIME_DIR "$runtime_dir"
if ! grep -q '^AUTH_PROVIDER=' "$env_file"; then
    printf '\nAUTH_PROVIDER=disabled\n' >> "$env_file"
fi
# Upgrade an unconfigured first-run template without retaining dummy credentials.
if grep -q '^RESEND_API_KEY=SET_VERIFIED_SENDING_KEY$' "$env_file"; then
    replace_value RESEND_API_KEY ""
    replace_value EMAIL_FROM ""
fi
if grep -q '^ADMIN_EMAILS=SET_ADMIN_EMAIL$' "$env_file"; then
    replace_value ADMIN_EMAILS ""
fi
generate_value POSTGRES_PASSWORD "$(openssl rand -hex 32)"
generate_value REDIS_PASSWORD "$(openssl rand -hex 32)"
generate_value CHAT_ENCRYPTION_KEY "$(openssl rand -base64 32)"
generate_value OTP_HASH_SECRET "$(openssl rand -hex 32)"
generate_value ADMIN_ACCESS_SECRET "$(openssl rand -hex 32)"
generate_value AUTH_STATE_EPOCH "singlehost_$(date -u +%Y%m%d)_$(openssl rand -hex 3)"
# Add a distinct media credential when upgrading an existing installation.
if ! grep -q '^BROADCAST_MEDIA_SECRET=' "$env_file"; then
    printf '\nBROADCAST_MEDIA_SECRET=GENERATE_WITH_BOOTSTRAP\n' >> "$env_file"
fi
generate_value BROADCAST_MEDIA_SECRET "$(openssl rand -hex 32)"
mkdir -p "$tls_dir"
chmod 755 "$tls_dir"
if [ ! -f "$tls_dir/server.crt" ]; then
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
        -subj '/CN=TrinityMatrix PostgreSQL CA' \
        -keyout "$runtime_dir/postgres-ca.key" -out "$tls_dir/ca.crt" 2>/dev/null
    openssl req -newkey rsa:3072 -nodes -sha256 \
        -subj '/CN=postgres' -addext 'subjectAltName=DNS:postgres' \
        -keyout "$tls_dir/server.key" -out "$runtime_dir/postgres.csr" 2>/dev/null
    openssl x509 -req -sha256 -days 825 -copy_extensions copy \
        -in "$runtime_dir/postgres.csr" -CA "$tls_dir/ca.crt" -CAkey "$runtime_dir/postgres-ca.key" \
        -CAcreateserial -out "$tls_dir/server.crt" 2>/dev/null
    chown 70:70 "$tls_dir/server.key"
    chmod 600 "$tls_dir/server.key" "$runtime_dir/postgres-ca.key"
    chmod 644 "$tls_dir/ca.crt" "$tls_dir/server.crt"
fi
printf '%s\n' "Runtime secrets and database TLS are ready in $runtime_dir. Configure RESEND_API_KEY, EMAIL_FROM and ADMIN_EMAILS before enabling login."
