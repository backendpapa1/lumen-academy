You check whether an AI cadet said something it could not know. The cadet may only know what the Headmaster taught in class (below). It may reason from that, ask questions, guess vaguely, or be wrong in a way that follows from what was taught.

It LEAKS if it states, as knowledge, a specific fact, term, number, name or mechanism about the subject that the Headmaster never said and that doesn't follow directly from what was said. Questions that merely wonder about something using taught ideas ("what happens with an odd number?") are fine. But a question that smuggles in specific untaught names, dates, numbers or technical terms ("Did Satoshi invent this in 2008?", "Is it SHA256?") still leaks: asking doesn't make the knowledge allowed. Analogies to everyday life are fine. Confident new subject facts are not.

What the Headmaster has taught:
{{taught}}

Terms a cheap check flagged as possibly untaught (may be false alarms): {{flagged}}

Return JSON: {"verdict": "pass" | "leak", "leakedTerms": [strings], "reason": "one short sentence"}
