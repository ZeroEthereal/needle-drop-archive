ALTER TABLE `managed_songs` ADD COLUMN `last_confirmed_at` text;
--> statement-breakpoint
UPDATE `managed_songs`
SET `last_confirmed_at` = COALESCE(`updated_at`, `last_seen_at`);
--> statement-breakpoint
UPDATE `managed_songs`
SET `last_playable_at` = `first_seen_at`
WHERE `bucket` = 'anomaly'
  AND `last_playable_at` IS NULL
  AND `first_seen_at` = (SELECT MIN(`first_seen_at`) FROM `managed_songs`);
--> statement-breakpoint
CREATE INDEX `managed_last_confirmed_idx` ON `managed_songs` (`last_confirmed_at`, `song_id`);
