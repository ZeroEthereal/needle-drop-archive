ALTER TABLE `playlist_song_states` ADD COLUMN `playlist_position` integer
  CHECK (`playlist_position` IS NULL OR (typeof(`playlist_position`) = 'integer' AND `playlist_position` >= 0));
