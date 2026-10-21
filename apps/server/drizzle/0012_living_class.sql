CREATE TABLE `stickers` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`period_id` text,
	`cadet_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cadet_id`) REFERENCES `cadets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stickers_classroom` ON `stickers` (`classroom_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `cadets` ADD `interests_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `cadets` ADD `arc_json` text;