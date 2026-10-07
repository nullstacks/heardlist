# Design notes: Heardlist

World: amateur-radio QSL cards. A proxy list is a "heard list" of relay stations. Cobalt field, signal-yellow stamps, cool paper, navy ink.

- Landing (persuade): cobalt owns masthead, hero, close. The hero is a live station card drawn from `/v1/random`; the station number "tunes in" (digits scramble, then settle). Header ruler is a tuning dial; the yellow needle tracks scroll position.
- Docs (read): cobalt rail and masthead frame a calm paper column (~70ch). Endpoint headings carry a stamped GET plate. Code blocks are ink-navy.
- Type: Bricolage Grotesque (display), Hanken Grotesk (body), JetBrains Mono (code and data only).
- Color: cobalt #1b2ce0, signal #ffd60a, ink #0a0f3a, paper #f3f5ff. Tokens in `public/assets/site.css`.
- Not run: the impeccable engine/detector and the finish-review agent (no network in the build sandbox).
