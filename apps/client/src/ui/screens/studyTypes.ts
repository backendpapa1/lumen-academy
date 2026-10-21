// What the study hall gets from the server (routes/study.ts).

export interface StudySource {
  id: string;
  title: string;
  kind: string;
  url: string | null;
  pages: number | null;
  original: boolean;
}

export interface StudyConcept {
  id: string;
  title: string;
  summary: string;
  keyFacts: string[];
  misconceptions: string[];
}

export interface Passage {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  page: number | null;
  heading: string | null;
  excerpt: string;
}

export interface ClassPrep {
  classroomId: string;
  classroomName: string;
  concept: StudyConcept;
  why: "current" | "next" | "weak";
  passages: Passage[];
  studied: { quotes: number; explanations: number };
}

export interface Lookup {
  id: string;
  kind: "question" | "mistake" | "misconception";
  text: string;
  who: string | null;
  conceptId: string | null;
  conceptTitle: string | null;
}

export interface Classmate {
  id: string;
  name: string;
  archetype: string;
  hair: string;
  register: string;
}

export interface StudyData {
  school: { id: string; name: string };
  sources: StudySource[];
  notes: { body: string; updatedAt: string | null };
  prep: ClassPrep[];
  lookups: Lookup[];
  classmates: Classmate[];
  todayMinutes: number;
  settings: { breakMinutes: number; longStudyMinutes: number; interruptEveryMinutes: number };
}

export interface ReaderChapter {
  key: string;
  title: string;
  pages: string | null;
  firstPage: number | null;
  firstChunkId: string;
  chunkIds: string[];
  minutes: number;
  skip: boolean;
  read: boolean;
}

export interface ExplanationCheck {
  verdict: "clear" | "partly" | "unclear";
  covered: string[];
  missed: string[];
  wrong: string | null;
  studentReply: string;
  tip: string;
}

/** Ask the reader to show a passage (a prep card's "Read it"). */
export const SHOW_PASSAGE = "study:show-passage";
export interface ShowPassage {
  sourceId: string;
  chunkId: string;
}
