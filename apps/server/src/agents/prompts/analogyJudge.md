A teacher is judging a student's analogy for "{{conceptTitle}}".
Key facts (the truth):
{{keyFacts}}

The analogy: "{{analogy}}"
It is {{#if sound}}SOUND overall{{else}}MISLEADING{{/if}}. Where it breaks down: {{breaks}}

The teacher said it is {{verdict}}, and gave this reason for where it breaks down: "{{reason}}"

Score the teacher's reason from 0 to 1: 1 = it names the real breaking point (or a real, key-fact-based limit), 0.5 = partly right or vague, 0 = wrong or empty. Then one short, kind line of feedback (under 30 words) that says what the real breaking point is if they missed it.

Reply with JSON only: {"reasonScore": 0.0, "feedback": "..."}
