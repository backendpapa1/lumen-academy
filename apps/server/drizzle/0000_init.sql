CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_type` text,
	`owner_id` text,
	`prompt` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`model` text NOT NULL,
	`params_json` text NOT NULL,
	`file_path` text,
	`status` text NOT NULL,
	`cost_usd` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_hash` ON `assets` (`prompt_hash`);--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`title` text NOT NULL,
	`questions_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assignments_classroom` ON `assignments` (`classroom_id`);--> statement-breakpoint
CREATE TABLE `cadets` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`seat` integer NOT NULL,
	`name` text NOT NULL,
	`homeworld` text NOT NULL,
	`archetype` text NOT NULL,
	`traits_json` text NOT NULL,
	`learning_style` text NOT NULL,
	`quirk` text NOT NULL,
	`voice_notes` text NOT NULL,
	`backstory` text,
	`portrait_asset_id` text,
	`notes_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'enrolled' NOT NULL,
	`enrolled_at` text NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cadets_classroom_seat` ON `cadets` (`classroom_id`,`seat`);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`ord` integer NOT NULL,
	`text` text NOT NULL,
	`heading_path` text,
	`page_from` integer,
	`page_to` integer,
	`token_count` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chunks_source_ord` ON `chunks` (`source_id`,`ord`);--> statement-breakpoint
CREATE TABLE `classrooms` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`name` text NOT NULL,
	`difficulty` text DEFAULT 'standard' NOT NULL,
	`status` text NOT NULL,
	`seed` integer NOT NULL,
	`current_concept_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `classrooms_school` ON `classrooms` (`school_id`);--> statement-breakpoint
CREATE TABLE `concept_citations` (
	`concept_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	PRIMARY KEY(`concept_id`, `chunk_id`),
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`ord` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`key_facts_json` text NOT NULL,
	`misconceptions_json` text NOT NULL,
	`prerequisites_json` text NOT NULL,
	`difficulty` integer NOT NULL,
	`status` text DEFAULT 'untaught' NOT NULL,
	`my_mastery` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `concepts_module_ord` ON `concepts` (`module_id`,`ord`);--> statement-breakpoint
CREATE TABLE `debriefs` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`exam_id` text,
	`content_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exam_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`exam_id` text NOT NULL,
	`ord` integer NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`options_json` text,
	`answer_key` text NOT NULL,
	`rubric` text NOT NULL,
	`concept_id` text NOT NULL,
	`citations_json` text NOT NULL,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_questions_exam_ord` ON `exam_questions` (`exam_id`,`ord`);--> statement-breakpoint
CREATE TABLE `exam_results` (
	`exam_id` text NOT NULL,
	`question_id` text NOT NULL,
	`cadet_id` text NOT NULL,
	`answer` text NOT NULL,
	`score` real NOT NULL,
	`rationale` text,
	PRIMARY KEY(`exam_id`, `question_id`, `cadet_id`),
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `exam_questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cadet_id`) REFERENCES `cadets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exams` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`module_id` text NOT NULL,
	`status` text NOT NULL,
	`pass_threshold` real DEFAULT 0.7 NOT NULL,
	`class_average` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exams_classroom` ON `exams` (`classroom_id`);--> statement-breakpoint
CREATE TABLE `exit_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`cadet_id` text NOT NULL,
	`concept_id` text,
	`statement` text NOT NULL,
	`correct` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cadet_id`) REFERENCES `cadets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exit_tickets_period` ON `exit_tickets` (`period_id`);--> statement-breakpoint
CREATE TABLE `leak_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`utterance_id` text NOT NULL,
	`cadet_id` text NOT NULL,
	`flagged_terms_json` text,
	`action` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`cadet_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`comprehension` real DEFAULT 0 NOT NULL,
	`exposures` integer DEFAULT 0 NOT NULL,
	`misconceptions_json` text DEFAULT '[]' NOT NULL,
	`last_taught_at` text,
	PRIMARY KEY(`cadet_id`, `concept_id`),
	FOREIGN KEY (`cadet_id`) REFERENCES `cadets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`speaker` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`concept_id` text,
	`reply_to_id` text,
	`meta_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_period_created` ON `messages` (`period_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`ord` integer NOT NULL,
	`title` text NOT NULL,
	`goal` text,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `modules_school_ord` ON `modules` (`school_id`,`ord`);--> statement-breakpoint
CREATE TABLE `periods` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`planned_minutes` integer NOT NULL,
	`recap_in` text,
	`recap_out` text,
	`random_event` text,
	`xp_earned` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`classroom_id`) REFERENCES `classrooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `periods_classroom_started` ON `periods` (`classroom_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `schools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`building_tier` integer DEFAULT 0 NOT NULL,
	`emblem_asset_id` text,
	`accent_color` text,
	`campus_slot` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`file_path` text,
	`page_count` integer,
	`status` text NOT NULL,
	`outline_json` text,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sources_school` ON `sources` (`school_id`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`cadet_id` text NOT NULL,
	`answers_json` text NOT NULL,
	`my_score` real,
	`my_comment` text,
	`ref_score` real,
	`ref_rationale` text,
	`graded_at` text,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cadet_id`) REFERENCES `cadets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_assignment_cadet` ON `submissions` (`assignment_id`,`cadet_id`);--> statement-breakpoint
CREATE TABLE `teacher_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`concept_id` text,
	`claim` text NOT NULL,
	`correction` text NOT NULL,
	`citation` text,
	`resolved` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `teacher_errors_concept` ON `teacher_errors` (`concept_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`ord` integer NOT NULL,
	`teacher_message_id` text NOT NULL,
	`analysis_json` text NOT NULL,
	`reactions_json` text NOT NULL,
	`low_confidence` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_period_ord` ON `turns` (`period_id`,`ord`);--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`agent` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`cached_tokens` integer,
	`output_tokens` integer,
	`images` integer,
	`latency_ms` integer,
	`est_usd` real,
	`period_id` text,
	`fallback_used` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_log_ts` ON `usage_log` (`ts`);--> statement-breakpoint
CREATE INDEX `usage_log_period` ON `usage_log` (`period_id`);--> statement-breakpoint
CREATE TABLE `xp_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`school_id` text,
	`classroom_id` text,
	`period_id` text
);
--> statement-breakpoint
CREATE INDEX `xp_events_ts` ON `xp_events` (`ts`);