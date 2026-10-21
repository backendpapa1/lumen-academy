A teacher is practising explaining "{{conceptTitle}}" at different levels.
Key facts (the truth):
{{keyFacts}}

This round's audience: {{audience}}.
{{#if eli5}}Fit means: no jargon at all, short sentences, a concrete picture a 5-year-old would get, and still true.{{/if}}{{#if eli15}}Fit means: plain words with a few real terms explained, one good example, and correct.{{/if}}{{#if expert}}Fit means: rigour. Precise terms, the actual mechanism, no hand-waving, and every claim correct against the key facts.{{/if}}

The teacher's explanation: "{{explanation}}"

Score the fit from 0 to 1 (1 = right for this audience AND true to the key facts; anything contradicting a key fact caps it at 0.4). Then one short, kind line of feedback (under 30 words): what worked, and the one thing to change.

Reply with JSON only: {"reasonScore": 0.0, "feedback": "..."}
