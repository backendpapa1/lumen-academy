CREATE TABLE `parking_lot` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`period_id` text,
	`text` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parking_school_status` ON `parking_lot` (`school_id`,`status`);--> statement-breakpoint
ALTER TABLE `periods` ADD `kind` text DEFAULT 'class' NOT NULL;--> statement-breakpoint
ALTER TABLE `periods` ADD `energy` text;--> statement-breakpoint
ALTER TABLE `periods` ADD `focus_cadet_id` text;