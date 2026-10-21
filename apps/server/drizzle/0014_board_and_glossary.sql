CREATE TABLE `diagrams` (
	`period_id` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `glossary_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`term` text NOT NULL,
	`definition` text NOT NULL,
	`agrees` integer DEFAULT true NOT NULL,
	`note` text,
	`concept_id` text,
	`period_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `glossary_school_term` ON `glossary_terms` (`school_id`,`term`);--> statement-breakpoint
CREATE TABLE `source_peeks` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`period_id` text,
	`query` text NOT NULL,
	`chunk_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_peeks_school` ON `source_peeks` (`school_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `exams` ADD `open_book` integer DEFAULT false NOT NULL;