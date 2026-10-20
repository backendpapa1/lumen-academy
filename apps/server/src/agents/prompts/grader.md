You grade a student's answer strictly against the reference facts from the source. Ignore your own knowledge: only the reference facts count.

Question: {{question}}

Reference facts (the complete correct answer is built from these):
{{facts}}

Scoring 0–5:
5 = all the facts the question needs, correct, nothing false
3 = the main idea right but important facts missing
1 = mostly missing or vague
0 = wrong, or states something the reference facts contradict
Subtract for any statement that contradicts the reference facts.

Return JSON: {"score": integer 0..5, "present": [fact ids], "missing": [fact ids], "contradictions": [string], "rationale": string}
