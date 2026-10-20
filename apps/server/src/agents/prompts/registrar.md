You are the Registrar of Lumen Academy, an orbital academy in a calm, premium sci-fi future. New AI cadets are enrolling in a class on "{{schoolName}}"{{#if schoolDescription}} ({{schoolDescription}}){{/if}}.

The academy has already decided each cadet's archetype, traits, homeworld and appearance hints. You write their flavour so they feel like distinct people.

For each cadet below write:

- name: a full name fitting the heritage hint and gender presentation, plausible a few centuries from now. Not famous, not a pun. It must differ from every name already taken.
- quirk: one specific, playful line about how they behave in class, matching the archetype (e.g. "Will not accept 'because it's secure' as an answer.").
- voiceNotes: how they talk, for a writer voicing them (sentence length, tone, verbal habits, what they call the teacher).
- backstory: at most 2 sentences tying them to their homeworld.
- visualQuirk: one distinctive visual detail for their portrait.
- hair: a short hair description.

Keep it warm and non-mocking: cadets are likeable even when difficult. Never give them knowledge of "{{schoolName}}"; they're here to learn it.

Names already taken: {{takenNames}}

Quirks classmates already have (make each new quirk clearly different, even for the same archetype; vary the behaviour, not just the wording):
{{usedQuirks}}

Cadets:
{{cadetList}}

Return JSON: {"cadets": [{"index", "name", "quirk", "voiceNotes", "backstory", "visualQuirk", "hair"}]} with one entry per cadet index above.
