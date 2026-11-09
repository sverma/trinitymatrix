CREATE TABLE admin_passkey_credentials (
  credential_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_name text NOT NULL,
  backed_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  CONSTRAINT admin_passkey_credential_id_shape CHECK (
    char_length(credential_id) BETWEEN 16 AND 1024
    AND credential_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT admin_passkey_public_key_length CHECK (octet_length(public_key) BETWEEN 16 AND 4096),
  CONSTRAINT admin_passkey_counter_nonnegative CHECK (counter >= 0),
  CONSTRAINT admin_passkey_device_name_length CHECK (char_length(device_name) BETWEEN 2 AND 64),
  CONSTRAINT admin_passkey_transports_known CHECK (
    transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
  )
);

CREATE INDEX admin_passkey_credentials_user_idx
  ON admin_passkey_credentials(user_id, created_at, credential_id);

CREATE TABLE admin_passkey_recovery_codes (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  code_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash),
  CONSTRAINT admin_passkey_recovery_hash_length CHECK (octet_length(code_hash) = 32)
);

CREATE INDEX admin_passkey_recovery_unused_idx
  ON admin_passkey_recovery_codes(user_id, created_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE admin_passkey_credentials IS
  'Phishing-resistant WebAuthn credentials for allowlisted administrators.';
COMMENT ON TABLE admin_passkey_recovery_codes IS
  'One-time high-entropy recovery code hashes; plaintext is shown once and never persisted.';
