PRAGMA defer_foreign_keys = true;
--> statement-breakpoint
CREATE TABLE `managed_songs_next` (
	`song_id` text PRIMARY KEY NOT NULL,
	`bucket` text DEFAULT 'normal' NOT NULL,
	`anomaly_type` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_playable_at` text,
	`confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "managed_bucket_valid" CHECK(`bucket` IN ('normal', 'anomaly')),
	CONSTRAINT "managed_anomaly_valid" CHECK(
		(`bucket` = 'normal' AND `anomaly_type` IS NULL AND `confirmed_at` IS NULL)
		OR
		(`bucket` = 'anomaly' AND `anomaly_type` IN ('grey', 'missing') AND `confirmed_at` IS NOT NULL)
	)
);
--> statement-breakpoint
INSERT INTO `managed_songs_next` (
	`song_id`, `bucket`, `anomaly_type`, `first_seen_at`, `last_seen_at`,
	`last_playable_at`, `confirmed_at`, `created_at`, `updated_at`
)
SELECT
	`song_id`,
	CASE WHEN `candidate_type` IS NOT NULL THEN 'anomaly' ELSE `bucket` END,
	CASE WHEN `candidate_type` IS NOT NULL THEN `candidate_type` ELSE `anomaly_type` END,
	`first_seen_at`,
	`last_seen_at`,
	`last_playable_at`,
	CASE WHEN `candidate_type` IS NOT NULL THEN `updated_at` ELSE `confirmed_at` END,
	`created_at`,
	`updated_at`
FROM `managed_songs`;
--> statement-breakpoint
DROP TABLE `managed_songs`;
--> statement-breakpoint
ALTER TABLE `managed_songs_next` RENAME TO `managed_songs`;
--> statement-breakpoint
CREATE INDEX `managed_bucket_type_idx` ON `managed_songs` (`bucket`, `anomaly_type`, `confirmed_at`);
--> statement-breakpoint
CREATE INDEX `managed_last_seen_idx` ON `managed_songs` (`last_seen_at`, `song_id`);
--> statement-breakpoint
CREATE TABLE `sync_runs_next` (
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
	`error_code` text,
	`error_message` text,
	`binding_version` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `sync_runs_next` (
	`id`, `trigger`, `status`, `phase`, `observed_at`, `shanghai_date`,
	`started_at`, `completed_at`, `current_song_count`, `new_count`,
	`confirmed_missing_count`, `confirmed_grey_count`, `auto_recovered_count`,
	`error_code`, `error_message`, `binding_version`, `created_at`, `updated_at`
)
SELECT
	`id`, `trigger`, `status`, `phase`, `observed_at`, `shanghai_date`,
	`started_at`, `completed_at`, `current_song_count`, `new_count`,
	`confirmed_missing_count`, `confirmed_grey_count`, `auto_recovered_count`,
	`error_code`, `error_message`, `binding_version`, `created_at`, `updated_at`
FROM `sync_runs`;
--> statement-breakpoint
DROP TABLE `sync_runs`;
--> statement-breakpoint
ALTER TABLE `sync_runs_next` RENAME TO `sync_runs`;
--> statement-breakpoint
CREATE INDEX `sync_runs_started_idx` ON `sync_runs` (`started_at`);
