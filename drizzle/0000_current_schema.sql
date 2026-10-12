CREATE TABLE `instance_config` (
	`id` text PRIMARY KEY DEFAULT 'primary' NOT NULL,
	`account_uid` text,
	`account_nickname` text,
	`account_avatar_url` text,
	`binding_version` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'unconfigured' NOT NULL,
	`bound_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT `instance_config_singleton` CHECK(`id` = 'primary'),
	CONSTRAINT `instance_config_status` CHECK(`status` IN ('unconfigured', 'ready', 'rebinding', 'error')),
	CONSTRAINT `instance_config_version` CHECK(`binding_version` >= 0)
);
--> statement-breakpoint
CREATE TABLE `monitored_playlists` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `cover_url` text,
  `owner_uid` text NOT NULL,
  `owner_name` text NOT NULL,
  `owned` integer DEFAULT 0 NOT NULL,
  `special_type` integer,
  `list_order` integer NOT NULL,
  `baseline_established` integer DEFAULT 0 NOT NULL,
  `bound_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `netease_auth_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`challenge_ciphertext` text NOT NULL,
	`challenge_nonce` text NOT NULL,
	`challenge_key_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'waiting_scan' NOT NULL,
	`session_id` text,
	`account_uid` text,
	`account_nickname` text,
	`account_avatar_url` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT `auth_flow_mode` CHECK(`mode` IN ('initial', 'reauthorize')),
	CONSTRAINT `auth_flow_status` CHECK(`status` IN ('waiting_scan', 'waiting_confirm', 'authorized', 'expired', 'cancelled', 'error')),
	FOREIGN KEY (`session_id`) REFERENCES `netease_sessions`(`id`) ON UPDATE no action ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `netease_sessions` (
	`id` text PRIMARY KEY DEFAULT 'primary' NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`algorithm` text DEFAULT 'AES-256-GCM' NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`uid` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_validated_at` text,
	`last_refreshed_at` text
);
--> statement-breakpoint
CREATE TABLE `pending_playlist_baselines` (
  `binding_id` text NOT NULL,
  `playlist_id` text NOT NULL,
  `song_json` text NOT NULL,
  `state_json` text NOT NULL,
  `verified_at` text NOT NULL,
  PRIMARY KEY (`binding_id`, `playlist_id`),
  FOREIGN KEY (`binding_id`) REFERENCES `pending_playlist_sets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `pending_playlist_sets` (
  `id` text PRIMARY KEY NOT NULL,
  `auth_flow_id` text,
  `session_id` text NOT NULL,
  `account_uid` text NOT NULL,
  `account_nickname` text NOT NULL,
  `account_avatar_url` text,
  `playlist_json` text NOT NULL,
  `base_binding_version` integer NOT NULL,
  `status` text DEFAULT 'preparing' NOT NULL,
  `workflow_id` text,
  `error_code` text,
  `error_message` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `netease_sessions`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `pending_set_status_valid` CHECK (`status` IN ('preparing', 'running', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "playlist_song_states" (
  `playlist_id` text NOT NULL,
  `song_id` text NOT NULL,
  `bucket` text DEFAULT 'normal' NOT NULL,
  `anomaly_type` text,
  `first_seen_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `last_confirmed_at` text NOT NULL,
  `last_playable_at` text,
  `confirmed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `playlist_position` integer
  CHECK (`playlist_position` IS NULL OR (typeof(`playlist_position`) = 'integer' AND `playlist_position` >= 0)),
  PRIMARY KEY (`playlist_id`, `song_id`),
  FOREIGN KEY (`playlist_id`) REFERENCES `monitored_playlists`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON DELETE CASCADE,
  CONSTRAINT `playlist_state_bucket_valid` CHECK (`bucket` IN ('normal', 'anomaly')),
  CONSTRAINT `playlist_state_anomaly_valid` CHECK (
    (`bucket` = 'normal' AND `anomaly_type` IS NULL AND `confirmed_at` IS NULL)
    OR (`bucket` = 'anomaly' AND `anomaly_type` IN ('grey', 'missing', 'mismatch') AND `confirmed_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`artists` text NOT NULL,
	`album` text,
	`cover_url` text,
	`netease_url` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
, observed_title text, observed_artists text, `aliases` text, `translations` text, `duration_ms` integer);
--> statement-breakpoint
CREATE TABLE `sync_batches` (
  `id` text PRIMARY KEY NOT NULL,
  `trigger` text NOT NULL,
  `scope` text DEFAULT 'all' NOT NULL,
  `status` text NOT NULL,
  `binding_version` integer NOT NULL,
  `account_uid` text NOT NULL,
  `playlist_count` integer NOT NULL,
  `success_count` integer DEFAULT 0 NOT NULL,
  `failure_count` integer DEFAULT 0 NOT NULL,
  `unexecuted_count` integer DEFAULT 0 NOT NULL,
  `current_playlist_id` text,
  `workflow_id` text,
  `error_code` text,
  `error_message` text,
  `started_at` text,
  `completed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT `sync_batch_status_valid` CHECK (`status` IN ('queued', 'running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `sync_playlist_tasks` (
  `batch_id` text NOT NULL,
  `playlist_id` text NOT NULL,
  `list_order` integer NOT NULL,
  `playlist_name` text NOT NULL,
  `status` text DEFAULT 'unexecuted' NOT NULL,
  `phase` text,
  `workflow_id` text,
  `binding_version` integer NOT NULL,
  `error_code` text,
  `error_message` text,
  `observed_at` text,
  `current_song_count` integer,
  `new_count` integer,
  `confirmed_missing_count` integer,
  `confirmed_grey_count` integer,
  `auto_recovered_count` integer,
  `started_at` text,
  `completed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, confirmed_mismatch_count integer,
  PRIMARY KEY (`batch_id`, `playlist_id`),
  FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`id`) ON DELETE CASCADE,
  CONSTRAINT `sync_task_status_valid` CHECK (`status` IN ('unexecuted', 'queued', 'running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `auth_flows_expiry_idx` ON `netease_auth_flows` (`expires_at`, `status`);
--> statement-breakpoint
CREATE INDEX `monitored_playlists_order_idx` ON `monitored_playlists` (`list_order`, `id`);
--> statement-breakpoint
CREATE INDEX `playlist_states_anomaly_idx` ON `playlist_song_states` (`bucket`, `anomaly_type`, `song_id`);
--> statement-breakpoint
CREATE INDEX `playlist_states_playlist_seen_idx` ON `playlist_song_states` (`playlist_id`, `last_seen_at`, `song_id`);
--> statement-breakpoint
CREATE INDEX playlist_states_song_id_idx ON playlist_song_states (song_id);
--> statement-breakpoint
CREATE INDEX `songs_title_idx` ON `songs` (`title`);
--> statement-breakpoint
CREATE INDEX `sync_batches_recent_idx` ON `sync_batches` (`created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `sync_tasks_playlist_recent_idx` ON `sync_playlist_tasks` (`playlist_id`, `created_at`);
--> statement-breakpoint
INSERT INTO instance_config (id) VALUES ('primary');
