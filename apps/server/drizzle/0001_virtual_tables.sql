-- Virtual tables Drizzle can't model (docs/06 §2). Requires sqlite-vec loaded
-- before migrating (see src/db/client.ts).
-- Cosine distance because hybrid retrieval scores 0.6 × cosine (docs/05 §7).
CREATE VIRTUAL TABLE `chunk_vec` USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[1536] distance_metric=cosine
);
--> statement-breakpoint
-- Teacher messages only, for the cadets' recall_lesson tool.
CREATE VIRTUAL TABLE `message_vec` USING vec0(
  message_id TEXT PRIMARY KEY,
  embedding FLOAT[1536] distance_metric=cosine
);
--> statement-breakpoint
-- External-content FTS over chunks.text, kept in sync by triggers.
CREATE VIRTUAL TABLE `chunk_fts` USING fts5(text, content='chunks', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER `chunks_fts_ai` AFTER INSERT ON `chunks` BEGIN
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `chunks_fts_ad` AFTER DELETE ON `chunks` BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER `chunks_fts_au` AFTER UPDATE OF `text` ON `chunks` BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;
