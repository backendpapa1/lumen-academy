CREATE TABLE `curriculum_units` (
	`school_id` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`ord` integer NOT NULL,
	`chapters_json` text DEFAULT '[]' NOT NULL,
	`built_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `curriculum_units_source` ON `curriculum_units` (`school_id`,`source_id`);--> statement-breakpoint
ALTER TABLE `modules` ADD `unit_source_id` text;--> statement-breakpoint
ALTER TABLE `modules` ADD `unit_title` text;--> statement-breakpoint
ALTER TABLE `schools` ADD `continues_school_id` text;