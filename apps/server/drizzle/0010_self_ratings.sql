CREATE TABLE `self_ratings` (
	`concept_id` text PRIMARY KEY NOT NULL,
	`rating` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
