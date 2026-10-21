CREATE TABLE `speech_corrections` (
	`school_id` text NOT NULL,
	`heard` text NOT NULL,
	`meant` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speech_corrections_pair` ON `speech_corrections` (`school_id`,`heard`,`meant`);