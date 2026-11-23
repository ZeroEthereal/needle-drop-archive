ALTER TABLE songs ADD COLUMN baseline_duration_ms integer;
--> statement-breakpoint
ALTER TABLE songs ADD COLUMN observed_duration_ms integer;
--> statement-breakpoint
UPDATE songs SET baseline_duration_ms = duration_ms
WHERE typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 1 AND 9007199254740991;
