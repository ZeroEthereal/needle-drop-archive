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
CREATE INDEX `monitored_playlists_order_idx` ON `monitored_playlists` (`list_order`, `id`);
--> statement-breakpoint
CREATE TABLE `playlist_song_states` (
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
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`playlist_id`, `song_id`),
  FOREIGN KEY (`playlist_id`) REFERENCES `monitored_playlists`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON DELETE CASCADE,
  CONSTRAINT `playlist_state_bucket_valid` CHECK (`bucket` IN ('normal', 'anomaly')),
  CONSTRAINT `playlist_state_anomaly_valid` CHECK (
    (`bucket` = 'normal' AND `anomaly_type` IS NULL AND `confirmed_at` IS NULL)
    OR (`bucket` = 'anomaly' AND `anomaly_type` IN ('grey', 'missing') AND `confirmed_at` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `playlist_states_anomaly_idx` ON `playlist_song_states` (`bucket`, `anomaly_type`, `song_id`);
--> statement-breakpoint
CREATE INDEX `playlist_states_playlist_seen_idx` ON `playlist_song_states` (`playlist_id`, `last_seen_at`, `song_id`);
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
CREATE INDEX `sync_batches_recent_idx` ON `sync_batches` (`created_at`, `id`);
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
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`batch_id`, `playlist_id`),
  FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`id`) ON DELETE CASCADE,
  CONSTRAINT `sync_task_status_valid` CHECK (`status` IN ('unexecuted', 'queued', 'running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `sync_tasks_playlist_recent_idx` ON `sync_playlist_tasks` (`playlist_id`, `created_at`);
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
INSERT INTO `monitored_playlists` (
  `id`, `name`, `cover_url`, `owner_uid`, `owner_name`, `owned`,
  `special_type`, `list_order`, `baseline_established`, `bound_at`
)
SELECT `playlist_id`, COALESCE(`playlist_name`, '已绑定歌单'), `playlist_cover_url`,
       COALESCE(`playlist_owner_uid`, `account_uid`, ''),
       COALESCE(`playlist_owner_name`, `account_nickname`, '网易云用户'),
       `playlist_owned`, NULL, 0, 1, COALESCE(`bound_at`, CURRENT_TIMESTAMP)
FROM `instance_config`
WHERE `id` = 'primary' AND `playlist_id` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `playlist_song_states` (
  `playlist_id`, `song_id`, `bucket`, `anomaly_type`, `first_seen_at`,
  `last_seen_at`, `last_confirmed_at`, `last_playable_at`, `confirmed_at`,
  `created_at`, `updated_at`
)
SELECT i.`playlist_id`, m.`song_id`, m.`bucket`, m.`anomaly_type`,
       m.`first_seen_at`, m.`last_seen_at`, COALESCE(m.`last_confirmed_at`, m.`last_seen_at`),
       m.`last_playable_at`, m.`confirmed_at`, m.`created_at`, m.`updated_at`
FROM `managed_songs` m
CROSS JOIN `instance_config` i
WHERE i.`id` = 'primary' AND i.`playlist_id` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `sync_batches` (
  `id`, `trigger`, `scope`, `status`, `binding_version`, `account_uid`, `playlist_count`,
  `success_count`, `failure_count`, `unexecuted_count`, `current_playlist_id`,
  `started_at`, `completed_at`, `created_at`, `updated_at`
)
SELECT r.`id`, r.`trigger`, 'all',
       CASE WHEN r.`status` = 'running' THEN 'failed' WHEN r.`status` = 'success' THEN 'success' ELSE 'failed' END,
       COALESCE(r.`binding_version`, i.`binding_version`), COALESCE(i.`account_uid`, ''), 1,
       CASE WHEN r.`status` = 'success' THEN 1 ELSE 0 END,
       CASE WHEN r.`status` = 'success' THEN 0 ELSE 1 END, 0,
       i.`playlist_id`, r.`started_at`, r.`completed_at`, r.`created_at`, r.`updated_at`
FROM `sync_runs` r CROSS JOIN `instance_config` i
WHERE i.`playlist_id` IS NOT NULL AND r.`status` <> 'running';
--> statement-breakpoint
INSERT INTO `sync_playlist_tasks` (
  `batch_id`, `playlist_id`, `list_order`, `playlist_name`, `status`, `phase`,
  `binding_version`, `error_code`, `error_message`, `observed_at`,
  `current_song_count`, `new_count`, `confirmed_missing_count`,
  `confirmed_grey_count`, `auto_recovered_count`, `started_at`, `completed_at`,
  `created_at`, `updated_at`
)
SELECT r.`id`, i.`playlist_id`, 0, COALESCE(i.`playlist_name`, '已绑定歌单'),
       CASE WHEN r.`status` = 'success' THEN 'success' ELSE 'failed' END,
       r.`phase`, COALESCE(r.`binding_version`, i.`binding_version`),
       r.`error_code`, r.`error_message`, r.`observed_at`,
       r.`current_song_count`, r.`new_count`, r.`confirmed_missing_count`,
       r.`confirmed_grey_count`, r.`auto_recovered_count`, r.`started_at`,
       r.`completed_at`, r.`created_at`, r.`updated_at`
FROM `sync_runs` r CROSS JOIN `instance_config` i
WHERE i.`playlist_id` IS NOT NULL AND r.`status` <> 'running';
