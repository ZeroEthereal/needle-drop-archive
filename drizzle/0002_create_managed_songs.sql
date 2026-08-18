CREATE TABLE `managed_songs` (
	`song_id` text PRIMARY KEY NOT NULL,
	`bucket` text DEFAULT 'normal' NOT NULL,
	`anomaly_type` text,
	`candidate_type` text,
	`candidate_first_date` text,
	`candidate_last_date` text,
	`candidate_streak` integer DEFAULT 0 NOT NULL,
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
	),
	CONSTRAINT "managed_candidate_valid" CHECK(
		(
			`candidate_type` IS NULL
			AND `candidate_first_date` IS NULL
			AND `candidate_last_date` IS NULL
			AND `candidate_streak` = 0
		)
		OR
		(
			`bucket` = 'normal'
			AND `candidate_type` IN ('grey', 'missing')
			AND `candidate_first_date` IS NOT NULL
			AND `candidate_last_date` IS NOT NULL
			AND `candidate_streak` >= 1
		)
	)
);
--> statement-breakpoint
CREATE INDEX `managed_bucket_type_idx` ON `managed_songs` (`bucket`, `anomaly_type`, `confirmed_at`);
--> statement-breakpoint
CREATE INDEX `managed_last_seen_idx` ON `managed_songs` (`last_seen_at`, `song_id`);
--> statement-breakpoint
WITH `source_rows` AS (
	SELECT
		i.`song_id`,
		CASE WHEN i.`status` = 'open' THEN 'anomaly' ELSE 'normal' END AS `bucket`,
		CASE WHEN i.`status` = 'open' THEN i.`type` ELSE NULL END AS `anomaly_type`,
		CASE WHEN i.`status` = 'candidate' THEN i.`type` ELSE NULL END AS `candidate_type`,
		CASE WHEN i.`status` = 'candidate' THEN i.`first_observed_date` ELSE NULL END AS `candidate_first_date`,
		CASE WHEN i.`status` = 'candidate' THEN i.`last_observed_date` ELSE NULL END AS `candidate_last_date`,
		CASE WHEN i.`status` = 'candidate' THEN i.`confirmation_streak` ELSE 0 END AS `candidate_streak`,
		m.`first_seen_at`,
		m.`last_seen_at`,
		m.`last_playable_at`,
		CASE WHEN i.`status` = 'open' THEN COALESCE(i.`confirmed_at`, i.`updated_at`) ELSE NULL END AS `confirmed_at`,
		m.`created_at`,
		MAX(m.`updated_at`, i.`updated_at`) AS `updated_at`,
		CASE WHEN i.`status` = 'open' THEN 0 ELSE 1 END AS `priority`
	FROM `recovery_incidents` i
	JOIN `playlist_memberships` m ON m.`id` = i.`membership_id`
	WHERE i.`status` IN ('candidate', 'open')

	UNION ALL

	SELECT
		m.`song_id`,
		'normal',
		NULL,
		NULL,
		NULL,
		NULL,
		0,
		m.`first_seen_at`,
		m.`last_seen_at`,
		m.`last_playable_at`,
		NULL,
		m.`created_at`,
		m.`updated_at`,
		2
	FROM `playlist_memberships` m
	WHERE m.`is_current` = 1
),
`ranked_rows` AS (
	SELECT *, ROW_NUMBER() OVER (
		PARTITION BY `song_id`
		ORDER BY `priority`, COALESCE(`confirmed_at`, `updated_at`) DESC
	) AS `row_rank`
	FROM `source_rows`
)
INSERT INTO `managed_songs` (
	`song_id`, `bucket`, `anomaly_type`, `candidate_type`,
	`candidate_first_date`, `candidate_last_date`, `candidate_streak`,
	`first_seen_at`, `last_seen_at`, `last_playable_at`, `confirmed_at`,
	`created_at`, `updated_at`
)
SELECT
	`song_id`, `bucket`, `anomaly_type`, `candidate_type`,
	`candidate_first_date`, `candidate_last_date`, `candidate_streak`,
	`first_seen_at`, `last_seen_at`, `last_playable_at`, `confirmed_at`,
	`created_at`, `updated_at`
FROM `ranked_rows`
WHERE `row_rank` = 1;
