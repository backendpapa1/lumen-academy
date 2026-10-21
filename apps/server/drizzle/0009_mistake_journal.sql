ALTER TABLE `teacher_errors` ADD `recheck_right` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `teacher_errors` ADD `next_check_at` text;--> statement-breakpoint
ALTER TABLE `teacher_errors` ADD `last_checked_period` text;