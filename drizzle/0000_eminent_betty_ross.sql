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
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`sent_at` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_uq` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_events_status_idx` ON `notification_events` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `playlist_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`membership_epoch` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`left_at` text,
	`is_current` integer DEFAULT true NOT NULL,
	`account_playable` integer,
	`last_playable_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memberships_epoch_positive" CHECK("playlist_memberships"."membership_epoch" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_song_epoch_uq` ON `playlist_memberships` (`song_id`,`membership_epoch`);--> statement-breakpoint
CREATE INDEX `memberships_current_idx` ON `playlist_memberships` (`is_current`,`song_id`);--> statement-breakpoint
CREATE TABLE `recovery_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`membership_id` text NOT NULL,
	`song_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`first_observed_date` text NOT NULL,
	`last_observed_date` text NOT NULL,
	`confirmation_streak` integer DEFAULT 1 NOT NULL,
	`confirmed_at` text,
	`recovery_streak` integer DEFAULT 0 NOT NULL,
	`last_recovery_date` text,
	`last_normal_at` text,
	`resolved_at` text,
	`resolution` text,
	`suppressed_until_normal` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`membership_id`) REFERENCES `playlist_memberships`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "incidents_confirmation_streak_valid" CHECK("recovery_incidents"."confirmation_streak" >= 1),
	CONSTRAINT "incidents_recovery_streak_valid" CHECK("recovery_incidents"."recovery_streak" >= 0)
);
--> statement-breakpoint
CREATE INDEX `incidents_membership_type_idx` ON `recovery_incidents` (`membership_id`,`type`);--> statement-breakpoint
CREATE INDEX `incidents_open_idx` ON `recovery_incidents` (`status`,`type`,`confirmed_at`);--> statement-breakpoint
CREATE INDEX `incidents_song_idx` ON `recovery_incidents` (`song_id`,`status`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `songs_title_idx` ON `songs` (`title`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`phase` text,
	`observed_at` text,
	`shanghai_date` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`current_song_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`confirmed_missing_count` integer DEFAULT 0 NOT NULL,
	`confirmed_grey_count` integer DEFAULT 0 NOT NULL,
	`auto_recovered_count` integer DEFAULT 0 NOT NULL,
	`pending_review_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_runs_started_idx` ON `sync_runs` (`started_at`);