CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`week` text NOT NULL,
	`kind` text NOT NULL,
	`accepted_at` text NOT NULL,
	`completed_at` text,
	`progress_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `challenges_week` ON `challenges` (`week`);--> statement-breakpoint
CREATE TABLE `room_upgrades` (
	`classroom_id` text NOT NULL,
	`item` text NOT NULL,
	`placed_at` text NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_upgrades_item` ON `room_upgrades` (`classroom_id`,`item`);--> statement-breakpoint
CREATE TABLE `trophies` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`classroom_id` text,
	`kind` text NOT NULL,
	`exam_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `classrooms` ADD `photo_svg` text;--> statement-breakpoint
ALTER TABLE `concepts` ADD `mastered_at` text;