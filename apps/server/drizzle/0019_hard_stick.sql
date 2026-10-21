CREATE TABLE `study_explanations` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`kind` text NOT NULL,
	`cadet_id` text,
	`question` text,
	`text` text NOT NULL,
	`check_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `study_explanations_concept` ON `study_explanations` (`concept_id`);--> statement-breakpoint
CREATE TABLE `study_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`concept_id` text,
	`source_id` text,
	`chunk_id` text,
	`text` text NOT NULL,
	`page` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `study_quotes_concept` ON `study_quotes` (`concept_id`);--> statement-breakpoint
CREATE TABLE `study_reads` (
	`school_id` text NOT NULL,
	`source_id` text NOT NULL,
	`chapter_key` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`school_id`, `source_id`, `chapter_key`),
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `study_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`minutes` integer DEFAULT 0 NOT NULL,
	`intention` text,
	`outcome` text,
	`xp_awarded` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `study_sessions_started` ON `study_sessions` (`started_at`);