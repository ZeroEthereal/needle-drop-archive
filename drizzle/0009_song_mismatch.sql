ALTER TABLE songs ADD COLUMN observed_title text;
--> statement-breakpoint
ALTER TABLE songs ADD COLUMN observed_artists text;
--> statement-breakpoint
ALTER TABLE sync_playlist_tasks ADD COLUMN confirmed_mismatch_count integer;
--> statement-breakpoint
ALTER TABLE sync_runs ADD COLUMN confirmed_mismatch_count integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `playlist_song_states_next` (
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
    OR (`bucket` = 'anomaly' AND `anomaly_type` IN ('grey', 'missing', 'mismatch') AND `confirmed_at` IS NOT NULL)
  )
);

--> statement-breakpoint
INSERT INTO playlist_song_states_next SELECT * FROM playlist_song_states;
--> statement-breakpoint
DROP TABLE playlist_song_states;
--> statement-breakpoint
ALTER TABLE playlist_song_states_next RENAME TO playlist_song_states;
--> statement-breakpoint
CREATE INDEX `playlist_states_anomaly_idx` ON `playlist_song_states` (`bucket`, `anomaly_type`, `song_id`);
--> statement-breakpoint
CREATE INDEX `playlist_states_playlist_seen_idx` ON `playlist_song_states` (`playlist_id`, `last_seen_at`, `song_id`);
--> statement-breakpoint
CREATE INDEX playlist_states_song_id_idx ON playlist_song_states (song_id);
--> statement-breakpoint
CREATE TABLE `managed_songs_next` (
	`song_id` text PRIMARY KEY NOT NULL,
	`bucket` text DEFAULT 'normal' NOT NULL,
	`anomaly_type` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_confirmed_at` text,
	`last_playable_at` text,
	`confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "managed_bucket_valid" CHECK(`bucket` IN ('normal', 'anomaly')),
	CONSTRAINT "managed_anomaly_valid" CHECK(
		(`bucket` = 'normal' AND `anomaly_type` IS NULL AND `confirmed_at` IS NULL)
		OR
		(`bucket` = 'anomaly' AND `anomaly_type` IN ('grey', 'missing', 'mismatch') AND `confirmed_at` IS NOT NULL)
	)
);

--> statement-breakpoint
INSERT INTO managed_songs_next (song_id, bucket, anomaly_type, first_seen_at, last_seen_at, last_confirmed_at, last_playable_at, confirmed_at, created_at, updated_at) SELECT song_id, bucket, anomaly_type, first_seen_at, last_seen_at, last_confirmed_at, last_playable_at, confirmed_at, created_at, updated_at FROM managed_songs;
--> statement-breakpoint
DROP TABLE managed_songs;
--> statement-breakpoint
ALTER TABLE managed_songs_next RENAME TO managed_songs;
--> statement-breakpoint
CREATE INDEX managed_bucket_type_idx ON managed_songs (bucket, anomaly_type, confirmed_at);
--> statement-breakpoint
CREATE INDEX managed_last_seen_idx ON managed_songs (last_seen_at, song_id);
--> statement-breakpoint
CREATE INDEX managed_last_confirmed_idx ON managed_songs (last_confirmed_at, song_id);
