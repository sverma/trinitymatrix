CREATE TABLE post_game_chat_messages (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  body_ciphertext bytea NOT NULL,
  body_iv bytea NOT NULL,
  body_auth_tag bytea NOT NULL,
  body_key_version smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT post_game_chat_author_participant
    FOREIGN KEY (match_id, author_user_id)
    REFERENCES match_participants(match_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT post_game_chat_client_id_unique UNIQUE (match_id, author_user_id, client_message_id),
  CONSTRAINT post_game_chat_ciphertext_length CHECK (octet_length(body_ciphertext) BETWEEN 1 AND 1120),
  CONSTRAINT post_game_chat_iv_length CHECK (octet_length(body_iv) = 12),
  CONSTRAINT post_game_chat_auth_tag_length CHECK (octet_length(body_auth_tag) = 16),
  CONSTRAINT post_game_chat_key_version_positive CHECK (body_key_version > 0)
);

CREATE INDEX post_game_chat_match_page_idx
  ON post_game_chat_messages(match_id, created_at ASC, id ASC);
