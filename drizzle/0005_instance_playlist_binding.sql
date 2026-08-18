CREATE TABLE `instance_config` (
	`id` text PRIMARY KEY DEFAULT 'primary' NOT NULL,
	`account_uid` text,
	`account_nickname` text,
	`account_avatar_url` text,
	`playlist_id` text,
	`playlist_name` text,
	`playlist_cover_url` text,
	`playlist_owner_uid` text,
	`playlist_owner_name` text,
	`playlist_owned` integer DEFAULT false NOT NULL,
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
INSERT INTO `instance_config` (`id`) VALUES ('primary');
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
CREATE INDEX `auth_flows_expiry_idx` ON `netease_auth_flows` (`expires_at`, `status`);
--> statement-breakpoint
CREATE TABLE `pending_playlist_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_flow_id` text,
	`session_id` text NOT NULL,
	`account_uid` text NOT NULL,
	`account_nickname` text NOT NULL,
	`account_avatar_url` text,
	`playlist_id` text NOT NULL,
	`playlist_name` text NOT NULL,
	`playlist_cover_url` text,
	`playlist_owner_uid` text NOT NULL,
	`playlist_owner_name` text NOT NULL,
	`playlist_owned` integer DEFAULT false NOT NULL,
	`base_binding_version` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'preparing' NOT NULL,
	`workflow_id` text,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT `pending_binding_status` CHECK(`status` IN ('preparing', 'running', 'failed')),
	FOREIGN KEY (`auth_flow_id`) REFERENCES `netease_auth_flows`(`id`) ON UPDATE no action ON DELETE SET NULL,
	FOREIGN KEY (`session_id`) REFERENCES `netease_sessions`(`id`) ON UPDATE no action ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `pending_bindings_status_idx` ON `pending_playlist_bindings` (`status`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `binding_version` integer;
