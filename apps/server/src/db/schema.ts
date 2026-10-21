// Drizzle schema for data/lumen.db — mirrors docs/06-DATA-MODEL.md §2 plus ADR-006 D5.
// Virtual tables (sqlite-vec, FTS5) and their triggers live in the custom
// migration `0001_virtual_tables.sql`; Drizzle can't express them.
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () => text("created_at").notNull();

// --- Schools & sources --------------------------------------------------------

export const schools = sqliteTable("schools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  buildingTier: integer("building_tier").notNull().default(0), // 0..4
  emblemAssetId: text("emblem_asset_id"),
  accentColor: text("accent_color"),
  campusSlot: integer("campus_slot").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  /** V6-07: "I have an exam on Friday": the date (YYYY-MM-DD) the plan works back from. */
  examDate: text("exam_date"),
  createdAt: createdAt(),
});

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    title: text("title").notNull(),
    kind: text("kind", {
      enum: ["pdf", "md", "txt", "paste", "youtube", "web", "pptx", "anki", "notes"],
    }).notNull(),
    /** V6: the YouTube or web link a source came from. */
    url: text("url"),
    filePath: text("file_path"),
    pageCount: integer("page_count"),
    status: text("status", {
      enum: ["queued", "parsing", "embedding", "ready", "error"],
    }).notNull(),
    outlineJson: text("outline_json"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("sources_school").on(t.schoolId)],
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    ord: integer("ord").notNull(),
    text: text("text").notNull(),
    headingPath: text("heading_path"),
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    tokenCount: integer("token_count").notNull(),
  },
  (t) => [index("chunks_source_ord").on(t.sourceId, t.ord)],
);

// --- Curriculum ---------------------------------------------------------------

export const modules = sqliteTable(
  "modules",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    goal: text("goal"),
  },
  (t) => [index("modules_school_ord").on(t.schoolId, t.ord)],
);

export const concepts = sqliteTable(
  "concepts",
  {
    id: text("id").primaryKey(),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    keyFactsJson: text("key_facts_json").notNull(), // string[]
    misconceptionsJson: text("misconceptions_json").notNull(), // string[]
    prerequisitesJson: text("prerequisites_json").notNull(), // concept ids
    difficulty: integer("difficulty").notNull(),
    status: text("status", { enum: ["untaught", "taught", "weak", "mastered"] })
      .notNull()
      .default("untaught"),
    myMastery: real("my_mastery").notNull().default(0),
  },
  (t) => [index("concepts_module_ord").on(t.moduleId, t.ord)],
);

export const conceptCitations = sqliteTable(
  "concept_citations",
  {
    conceptId: text("concept_id")
      .notNull()
      .references(() => concepts.id),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => chunks.id),
  },
  (t) => [primaryKey({ columns: [t.conceptId, t.chunkId] })],
);

// --- Classrooms & cadets ------------------------------------------------------

export const classrooms = sqliteTable(
  "classrooms",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    name: text("name").notNull(),
    difficulty: text("difficulty", { enum: ["gentle", "standard", "ruthless"] })
      .notNull()
      .default("standard"),
    status: text("status", {
      enum: ["registering", "active", "graduated", "archived"],
    }).notNull(),
    seed: integer("seed").notNull(),
    currentConceptId: text("current_concept_id"),
    createdAt: createdAt(),
  },
  (t) => [index("classrooms_school").on(t.schoolId)],
);

export const cadets = sqliteTable(
  "cadets",
  {
    id: text("id").primaryKey(),
    classroomId: text("classroom_id")
      .notNull()
      .references(() => classrooms.id),
    seat: integer("seat").notNull(), // 0..14
    name: text("name").notNull(),
    homeworld: text("homeworld").notNull(),
    archetype: text("archetype").notNull(),
    traitsJson: text("traits_json").notNull(),
    learningStyle: text("learning_style").notNull(),
    quirk: text("quirk").notNull(),
    voiceNotes: text("voice_notes").notNull(),
    backstory: text("backstory"),
    portraitAssetId: text("portrait_asset_id"),
    notesMd: text("notes_md").notNull().default(""),
    /** V1-04: the Kokoro voice and pace, picked on first speech and kept. */
    voiceJson: text("voice_json"),
    /** V4-04: one or two everyday interests (JSON array of strings). */
    interestsJson: text("interests_json").notNull().default("[]"),
    /** V4-03: growth arc state {stage, count}; null = the first stage. */
    arcJson: text("arc_json"),
    status: text("status", { enum: ["enrolled", "transferred_in", "expelled", "alumni"] })
      .notNull()
      .default("enrolled"),
    enrolledAt: text("enrolled_at").notNull(),
  },
  (t) => [uniqueIndex("cadets_classroom_seat").on(t.classroomId, t.seat)],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    cadetId: text("cadet_id")
      .notNull()
      .references(() => cadets.id),
    conceptId: text("concept_id")
      .notNull()
      .references(() => concepts.id),
    comprehension: real("comprehension").notNull().default(0),
    exposures: integer("exposures").notNull().default(0),
    misconceptionsJson: text("misconceptions_json").notNull().default("[]"),
    lastTaughtAt: text("last_taught_at"),
    /** V2 forgetting: the half-life of this memory in days; spaced reviews grow it. */
    stabilityDays: real("stability_days"),
  },
  (t) => [primaryKey({ columns: [t.cadetId, t.conceptId] })],
);

// --- Teaching -----------------------------------------------------------------

export const periods = sqliteTable(
  "periods",
  {
    id: text("id").primaryKey(),
    classroomId: text("classroom_id")
      .notNull()
      .references(() => classrooms.id),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    plannedMinutes: integer("planned_minutes").notNull(),
    /** Teaching time so far: pauses and disconnects don't count. Saved on pause/suspend/end. */
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    recapIn: text("recap_in"),
    recapOut: text("recap_out"),
    randomEvent: text("random_event"),
    xpEarned: integer("xp_earned").notNull().default(0),
    /** V3-01: "class", or "micro" (one student, one idea, a few minutes). */
    kind: text("kind").notNull().default("class"),
    /** V3-02: the optional check-in before class: low / ok / high. */
    energy: text("energy"),
    /** V3-01: the one student at the front desk in a micro-lesson. */
    focusCadetId: text("focus_cadet_id"),
  },
  (t) => [index("periods_classroom_started").on(t.classroomId, t.startedAt)],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id")
      .notNull()
      .references(() => periods.id),
    ord: integer("ord").notNull(),
    teacherMessageId: text("teacher_message_id").notNull(),
    analysisJson: text("analysis_json").notNull(), // TeachingAnalysis (ADR-002)
    reactionsJson: text("reactions_json").notNull(), // CrowdReaction (ADR-002)
    lowConfidence: integer("low_confidence", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("turns_period_ord").on(t.periodId, t.ord)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id")
      .notNull()
      .references(() => periods.id),
    speaker: text("speaker").notNull(), // 'teacher' | cadet id | 'system'
    kind: text("kind", {
      enum: ["lecture", "question", "answer", "objection", "claim", "board", "event", "peer"],
    }).notNull(),
    text: text("text").notNull(),
    conceptId: text("concept_id"),
    replyToId: text("reply_to_id"),
    metaJson: text("meta_json"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_period_created").on(t.periodId, t.createdAt)],
);

export const exitTickets = sqliteTable(
  "exit_tickets",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id")
      .notNull()
      .references(() => periods.id),
    cadetId: text("cadet_id")
      .notNull()
      .references(() => cadets.id),
    conceptId: text("concept_id").references(() => concepts.id),
    statement: text("statement").notNull(),
    /** Whether the statement is true to the source (the server knows; the client doesn't). */
    isTrue: integer("is_true", { mode: "boolean" }).notNull().default(true),
    /** The Headmaster's ✓ (true) or ✗ (false); null until marked. */
    verdict: integer("verdict", { mode: "boolean" }),
    correct: integer("correct", { mode: "boolean" }), // was the verdict right? null until marked
    createdAt: createdAt(),
  },
  (t) => [index("exit_tickets_period").on(t.periodId)],
);

// --- Assessment ---------------------------------------------------------------

export const assignments = sqliteTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    classroomId: text("classroom_id")
      .notNull()
      .references(() => classrooms.id),
    title: text("title").notNull(),
    questionsJson: text("questions_json").notNull(),
    status: text("status", { enum: ["draft", "issued", "submitted", "graded"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("assignments_classroom").on(t.classroomId)],
);

export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    cadetId: text("cadet_id")
      .notNull()
      .references(() => cadets.id),
    answersJson: text("answers_json").notNull(),
    myScore: real("my_score"),
    myComment: text("my_comment"),
    refScore: real("ref_score"),
    refRationale: text("ref_rationale"),
    gradedAt: text("graded_at"),
  },
  (t) => [uniqueIndex("submissions_assignment_cadet").on(t.assignmentId, t.cadetId)],
);

export const exams = sqliteTable(
  "exams",
  {
    id: text("id").primaryKey(),
    classroomId: text("classroom_id")
      .notNull()
      .references(() => classrooms.id),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id),
    status: text("status", { enum: ["generating", "ready", "running", "done"] }).notNull(),
    passThreshold: real("pass_threshold").notNull().default(0.7),
    classAverage: real("class_average"),
    /** V6-06: set when I looked at my sources (/source) shortly before. */
    openBook: integer("open_book", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("exams_classroom").on(t.classroomId)],
);

export const examQuestions = sqliteTable(
  "exam_questions",
  {
    id: text("id").primaryKey(),
    examId: text("exam_id")
      .notNull()
      .references(() => exams.id),
    ord: integer("ord").notNull(),
    kind: text("kind", { enum: ["mcq", "short", "eli10"] }).notNull(),
    prompt: text("prompt").notNull(),
    optionsJson: text("options_json"),
    answerKey: text("answer_key").notNull(),
    rubric: text("rubric").notNull(),
    conceptId: text("concept_id")
      .notNull()
      .references(() => concepts.id),
    citationsJson: text("citations_json").notNull(),
  },
  (t) => [uniqueIndex("exam_questions_exam_ord").on(t.examId, t.ord)],
);

export const examResults = sqliteTable(
  "exam_results",
  {
    examId: text("exam_id")
      .notNull()
      .references(() => exams.id),
    questionId: text("question_id")
      .notNull()
      .references(() => examQuestions.id),
    cadetId: text("cadet_id")
      .notNull()
      .references(() => cadets.id),
    answer: text("answer").notNull(),
    score: real("score").notNull(), // 0..1
    rationale: text("rationale"),
  },
  (t) => [primaryKey({ columns: [t.examId, t.questionId, t.cadetId] })],
);

// --- Debrief, assets, ops -----------------------------------------------------

export const debriefs = sqliteTable("debriefs", {
  id: text("id").primaryKey(),
  classroomId: text("classroom_id")
    .notNull()
    .references(() => classrooms.id),
  examId: text("exam_id").references(() => exams.id),
  contentJson: text("content_json").notNull(),
  createdAt: createdAt(),
});

export const teacherErrors = sqliteTable(
  "teacher_errors",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id),
    conceptId: text("concept_id"),
    claim: text("claim").notNull(),
    correction: text("correction").notNull(),
    citation: text("citation"),
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    /** V2-05 mistake journal: right answers on a re-check (2 settles it), and when it's next due. */
    recheckRight: integer("recheck_right").notNull().default(0),
    nextCheckAt: text("next_check_at"),
    lastCheckedPeriod: text("last_checked_period"),
  },
  (t) => [index("teacher_errors_concept").on(t.conceptId)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["portrait", "emblem", "building_skin", "background", "card", "ui"],
    }).notNull(),
    ownerType: text("owner_type"),
    ownerId: text("owner_id"),
    prompt: text("prompt").notNull(),
    promptHash: text("prompt_hash").notNull(),
    model: text("model").notNull(),
    paramsJson: text("params_json").notNull(),
    filePath: text("file_path"),
    status: text("status", { enum: ["queued", "generating", "ready", "error"] }).notNull(),
    costUsd: real("cost_usd"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("assets_hash").on(t.promptHash)],
);

export const usageLog = sqliteTable(
  "usage_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    agent: text("agent").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    cachedTokens: integer("cached_tokens"),
    outputTokens: integer("output_tokens"),
    images: integer("images"),
    latencyMs: integer("latency_ms"),
    estUsd: real("est_usd"), // null when pricing.yaml has no price ("≈?")
    periodId: text("period_id"),
    fallbackUsed: integer("fallback_used", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("usage_log_ts").on(t.ts), index("usage_log_period").on(t.periodId)],
);

export const xpEvents = sqliteTable(
  "xp_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    schoolId: text("school_id"),
    classroomId: text("classroom_id"),
    periodId: text("period_id"),
  },
  (t) => [index("xp_events_ts").on(t.ts)],
);

export const leakEvents = sqliteTable("leak_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  utteranceId: text("utterance_id").notNull(),
  cadetId: text("cadet_id").notNull(),
  flaggedTermsJson: text("flagged_terms_json"),
  action: text("action", { enum: ["pass", "rewrite", "rewrite_failed"] }).notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

/** V1 voice: what Whisper heard vs what I meant, learned from my edits, per School. */
export const speechCorrections = sqliteTable(
  "speech_corrections",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    heard: text("heard").notNull(), // lower-case, 1–3 words
    meant: text("meant").notNull(), // as I typed it, 1–3 words
    count: integer("count").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("speech_corrections_pair").on(t.schoolId, t.heard, t.meant)],
);

/** V2-08: how well I think I know each concept (1–5), against the class's evidence. */
export const selfRatings = sqliteTable("self_ratings", {
  conceptId: text("concept_id")
    .primaryKey()
    .references(() => concepts.id),
  rating: integer("rating").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** V3-04: stray thoughts filed mid-class without leaving the flow. */
export const parkingLot = sqliteTable(
  "parking_lot",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    periodId: text("period_id"),
    text: text("text").notNull(),
    /** open → kept (a note) | concept (added to the curriculum) | dismissed. */
    status: text("status").notNull().default("open"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [index("parking_school_status").on(t.schoolId, t.status)],
);

/** V4-06: stickers students hand out for great moments. */
export const stickers = sqliteTable(
  "stickers",
  {
    id: text("id").primaryKey(),
    classroomId: text("classroom_id")
      .notNull()
      .references(() => classrooms.id),
    periodId: text("period_id"),
    /** Who gave it. */
    cadetId: text("cadet_id")
      .notNull()
      .references(() => cadets.id),
    kind: text("kind").notNull(),
    /** What earned it: my words, trimmed. */
    reason: text("reason").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("stickers_classroom").on(t.classroomId, t.createdAt)],
);

/** V6-06: each time I checked myself against my sources in class (/source). */
export const sourcePeeks = sqliteTable(
  "source_peeks",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    periodId: text("period_id"),
    query: text("query").notNull(),
    chunkId: text("chunk_id"),
    createdAt: createdAt(),
  },
  (t) => [index("source_peeks_school").on(t.schoolId, t.createdAt)],
);

/** V6-08: the glossary wall: terms I defined, in my words, checked against the key facts. */
export const glossaryTerms = sqliteTable(
  "glossary_terms",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    term: text("term").notNull(),
    definition: text("definition").notNull(),
    /** false when the Director found it disagrees with the key facts. */
    agrees: integer("agrees", { mode: "boolean" }).notNull().default(true),
    note: text("note"),
    conceptId: text("concept_id"),
    periodId: text("period_id"),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("glossary_school_term").on(t.schoolId, t.term)],
);

/** V6-09: the diagram on the board in a period (boxes, arrows, labels), as objects. */
export const diagrams = sqliteTable("diagrams", {
  periodId: text("period_id")
    .primaryKey()
    .references(() => periods.id),
  json: text("json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
