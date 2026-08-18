DROP TABLE IF EXISTS `recovery_incidents`;
--> statement-breakpoint
DROP TABLE IF EXISTS `playlist_memberships`;
--> statement-breakpoint
DELETE FROM `songs`
WHERE NOT EXISTS (
	SELECT 1 FROM `managed_songs`
	WHERE `managed_songs`.`song_id` = `songs`.`id`
);
