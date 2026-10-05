# character.mind: models, effort and limits

Six models, each with its own job. There are no "Version 2-5" models any more (old saved choices like "opys5" are read as the base model).

| Model | Plan | Job | Extra it does on its own |
|---|---|---|---|
| Opas | Free | Quick chat: fast and short | nothing |
| Opes | Free | Everyday storyteller | nothing |
| Opis | Advanced | Light coding (fenced code, about 60 lines), puzzles, mysteries | precise continuity |
| Opos | Advanced | Game master (place, health, items, numbered choices) | scene director: tracks who is where and what changed |
| Opus | X20 | Chapter writer (titled, numbered chapters, hook and cliffhanger) | remembers how the story began, never repeats itself |
| Opys | X50 | Master author, every ability | all of the above plus long-term memory notes and planned story arcs |
| Opys 5 | X100 | The flagship: extreme refinement (plans, writes, re-reads and fixes), longest and most detailed chapters, never reuses an image or phrase | everything Opys does, thinks as hard as Groq allows, writes about 3.5x as long as Opes at each effort |

The abilities are written into the AI's instructions (`MODEL_ABILITY`, `buildMemoryNote` in server.js) and only start when the user asks (for example "write chapter one").

## Effort: how long and how careful each reply is
- Low: a few quick sentences. Medium: one or two paragraphs. High: a full scene (3-5 paragraphs).
- Extra: long and detailed, planned before it is written. Max: chapter-length, planned, written and checked.
- High, Extra and Max ask for a word target: 350 / 600 / 900 words x the model's factor (Opas 0.7, Opes 1, Opis 1.1, Opos 1.3, Opus 1.6, Opys 1.9).
- Extra and Max add a REFINE instruction (plan, write, check). Opis, Opos, Opus and Opys also get longer hidden thinking on Extra and Max; Opas and Opes stay fast.
- Cost: Extra costs 1.5x, Max about 3.3x a Medium reply.

## Cost of one reply (allowance tokens), Medium effort
Opas 350, Opes 1,200, Opis 1,500, Opos 1,800, Opus 2,400, Opys 3,600, Opys 5 12,000. Max effort: Opas 1,200, Opes 4,000, Opis 5,000, Opos 6,000, Opus 8,000, Opys 12,000, Opys 5 40,000.

## Allowances (an average message = Opes at Medium = 1,200 tokens; weekly = 5 sessions)
| Plan | Messages per 2-hour session | Weekly |
|---|---|---|
| Free | 60 | 300 |
| Advanced | 150 | 750 |
| X20 | 3,000 | 15,000 |
| X50 | 7,500 | 37,500 |
| X100 | 15,000 | 75,000 |

## Prices (PayPal, test mode for now)
Advanced $4.99/mo or $44.99/yr. X20 $24.99/mo or $199.99/yr. X50 $49.99/mo or $399.99/yr. X100 $99.99/mo or $799.99/yr (Opys 5 is only on X100).

## How long can Opys 5 write?
It is asked for 1,250 / 2,100 / 3,150 words at High / Extra / Max (Opes: 350 / 600 / 900). What it can really write in one reply depends on the Groq plan: on the free plan a request holds about 7,400 tokens in total, so about 3,000 words. After upgrading Groq, raise GROQ_REQUEST_BUDGET, GROQ_LENGTH_SCALE and GROQ_ALLOW_HIGH_REASONING=1 on Render and replies grow with them (the cap is 40,000 tokens, about 28,000 words). 50,000 to 100,000 words cannot come from one reply: that needs a chapter-by-chapter book mode, which is not built yet.
