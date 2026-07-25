# Judging Prep — Every Second Matters

This is not a script to memorize word for word. It's built so that if you say roughly this, in roughly this order, you hit "eloquent introduction + methodically explains the coding process" (Exceptional Presentation) and "always responds with paragraph explanations, examples, and code references" (Exceptional Q&A) without needing to overclaim anything on Creativity or Implementation. Every line below exists because a specific council finding said it needed to.

---

## The 90-second opening (Presentation)

Say this near-verbatim. It is the single highest-leverage thing you can do tonight.

> "Ambulance response time is one of the strongest predictors of survival for cardiac arrest and stroke. Big cities already reposition ambulances based on data. Almost no small or mid-size county does, because they can't afford a data science team. We wanted to know if we could build that for them, cheap and honest.
>
> We didn't get there on the first try. Our first version showed a 36.8% improvement. That number was a bug: a few rows of garbage GPS coordinates in the raw data were dragging our baseline off the map. Once we fixed it, the real number was 0.1%. Not significant.
>
> So we tried two more approaches. Both came back as real, genuine null results: repositioning ambulances by time of day doesn't help, because where calls happen doesn't shift enough hour to hour. Only how many calls happen shifts.
>
> That told us we were solving the wrong problem. The real lever isn't time of day, it's reacting live to which ambulances are currently busy. We rebuilt around MEXCLP, a real published EMS operations-research method from 1983, and tested it on real 911 data from Seattle and Cincinnati with real road-network routing. Seattle: 16.7% faster. Cincinnati: 16.4% faster, both statistically significant. And for Cincinnati, we checked our simulation against the department's actual measured response times. We landed within 0.07 minutes.
>
> We also didn't stop at the textbook version of the algorithm. The published method assumes one busy fraction for the whole city, all day. We computed a separate one for every hour, using real hourly call data, so the recommended staging locations actually shift through the day. You can drag the time slider in the app right now and watch it happen.
>
> Here's the app."

**Why this works:** it is the methodical explanation of the coding process the rubric literally asks for, using your own real dead ends as the narrative spine instead of hiding them. It also pre-answers "how do you know this is real and not cherry-picked" before anyone asks it.

---

## Creativity: what to say when a judge implies "this is just a formula"

MEXCLP being 45 years old is true. Don't deny it. Reframe it, using the exact counter-argument three separate reviewers in our own evaluation process independently raised:

> "The algorithm isn't ours, and we're not pretending it is. What we built is the thing that's actually missing: the full real-data pipeline around it. No one else has run this exact method on real Seattle and Cincinnati 911 data, with real road routing instead of straight-line distance, and then checked the result against the department's real measured performance. Anyone can write an unvalidated demo with a made-up fleet. We validated ours to within 0.07 minutes of a real number. That's the hard part, and it's the part that's actually new here."

Also mention, briefly, if there's room: the app isn't hard-coded to two cities. Drop in any city's CAD export and the entire pipeline (clustering, MEXCLP, both simulations, the significance test) reruns from scratch, in the browser, with no server. That's a real generalization, not a demo trick.

---

## Implementation: what to say if a judge asks "did you have any bugs"

Don't say no. Say this:

> "Yes, and we're not going to pretend otherwise. A few hours before tonight, we found a stat in the live-simulation view that was wired up in the interface but never actually updated by the code. We caught it, traced it, and fixed it, verified against real numbers before we came here. That's what real QA looks like on a one-day build: you don't get zero bugs, you get bugs you found and fixed before it mattered."

This reframes the exact thing the council flagged as your Implementation ceiling (real bugs happened) into evidence of process rigor instead of a weakness to hide. It's honest, and it's the strongest version of the honest answer.

---

## The synthetic-data notebook: the one line you need pre-loaded

Do not wait for this to come up reactively. If you're walking a judge through the repo or they ask "is all this data real," say this, once, calmly, before it's a question:

> "One thing we want to flag ourselves: a teammate has a separate exploratory notebook with an invented fleet and made-up response times. It's labeled clearly in our docs as not real and not part of our results. Everything we've shown you tonight, the 16.7%, the 16.4%, the 0.07-minute validation, comes from the real pipeline, not that notebook."

Said this way, proactively and unbothered, it becomes a credibility signal. Said defensively after being caught, it's a red flag. The words are almost the same. The order and tone are what matter.

---

## The p-value question: what to say if a judge asks about p < 10⁻¹²⁰

This number is technically real but genuinely does invite the question "is that just because your sample is huge." Have this ready:

> "That p-value is large because our sample is large, fourteen thousand real calls in Seattle over sixty real days, not because we went fishing for significance. It's a single paired comparison, static versus dynamic on the exact same call stream, not multiple comparisons. A huge, real sample producing a very small p-value on one clean comparison is expected, not suspicious."

---

## The hardest possible technical question: MEXCLP's own real limitations

A sharp judge who actually knows operations research might not ask about your bugs at all. They might ask about the method itself. Be ready for this specific one:

> "MEXCLP, as published in 1983, assumes one busy fraction for the whole city, applied uniformly all day. We knew that was a real limitation, so we fixed it: we compute a separate busy fraction and a separate compliance table for every hour of the day, using that hour's own real call volume. That's why the recommended posts in the app actually move through the day instead of staying fixed. We haven't taken it to a per-post busy fraction yet, that's genuinely the next step, but the time-of-day version is real and running right now."

Having an answer for this, specifically, is what separates "sometimes responds with paragraph explanations and examples" from "always responds with paragraph explanations, examples, and references to the code."

---

## Order of operations for the room

1. Open with the 90-second story above. Do not skip the dead ends. They are your best material, not a confession.
2. Demo the Simple view first (real addresses, ranked posts), then Under the Hood (the live animated race), in that order. Non-technical framing first builds trust before the technical depth.
3. If asked "what's next," use the roadmap in DEVPOST.md: per-post busy fraction, hospital routing, a third city, a real county pilot.
4. In Q&A, if you don't know something, say so and connect it to what you do know, rather than guessing. "We haven't tested that, but here's the closest thing we did test and what it showed" is a paragraph-with-example answer. A guess dressed up as confidence is not.

## What NOT to do

- Don't claim zero bugs. It's not true and it's checkable if anyone asks pointed questions.
- Don't lead with the p-value as a trophy. Lead with the realism check (0.07 minutes) instead, it's more intuitively convincing and harder to poke holes in.
- Don't let the synthetic notebook come up as a surprise. You control when it's mentioned. Use that.
- Don't oversell Creativity. If a judge says "so this is a known algorithm," agree, then pivot immediately to the pipeline/validation/generalization argument above. Fighting the premise reads as defensive.
