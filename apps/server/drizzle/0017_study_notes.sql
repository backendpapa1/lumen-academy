CREATE TABLE `study_notes` (
	`school_id` text PRIMARY KEY NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
