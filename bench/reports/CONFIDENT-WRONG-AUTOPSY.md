# Confident-Wrong Autopsy

Task B12-2. Generated 2026-08-25 from `tests/benchmarks/reports/confident-wrong-autopsy.json`
(git `87df1fc`, same sha as baseline). Reproduction check against
`tests/benchmarks/reports/baseline.json`: queries=135, confidentWrong=5 (countMatch PASS),
macro=0.2898 (macroMatch PASS), micro=0.6296.

Definition note: the bench scorer buckets `penalty <= -0.5` as wrong regardless of verdict.
Four of the five cases carry verdict `confident` (best confidence >= 0.90); the fifth,
`edge_noise_q`, carries verdict `qualified` at 0.8458 and is counted by the scorer's wrong
bucket only. All five are dissected below.

Machine-readable dump (full evidence vectors, decompositions): 
`tests/benchmarks/reports/confident-wrong-autopsy.json`. Reproduce with:

```bash
bun scripts/diagnose-confident-wrong.ts
```

---

## Case 1: ua_6_q - "What is Fatimas favorite color?"

- Verdict: `confident`, bestConfidence **0.9438** (HIGH), penalty -1.
- Wrong top-1: `pf_8_false` - "My favorite snack is a peanut butter sandwich." (Hana's planted
  falsehood, first-person, zero relation to Fatima).
- Expected: abstain (`no_reliable_memory`). Nothing in the corpus answers this question.
- Top-3: pf_8_false (rc .9438 HIGH), pf_14_fact "Nikolai collects vintage film cameras."
  (.1215 LOW), pf_6_fact "Fatima is a pediatric nurse..." (.4612 LOW).

Evidence vector (top-1): semantic=1.0, lexical.rank=1 score=1.0, graph=null, stale=false,
supersededBy=null, conflictPenalty=null, memoryConfidence=speculative(x0.95),
supporting=0 contradicting=0, freshness=0.821, rerankAgreement=null,
**topicalAlignment=null**. Parsed query topic: {entity:"fatima", attribute:"color"}.
Candidate alignments: [null, null, null, null, 0].

Decomposition: base(semantic=1)=0.9820 -> +0.08 lexical top-3 bonus = 1.0000 -> margin
decisive (0.508) x1.05 -> retention x0.9462 -> speculative x0.95 => **0.9438**.

Root cause: the winner is a FIRST-PERSON memory ("My favorite snack...").
`extractMemoryTopic` returns entity=null for it (INITIAL_SKIP_WORDS swallows leading "My"),
so `topicalAlignment` stays null and the B1 same-entity/wrong-attribute guard never fires -
even though the query side parsed perfectly ({fatima, color}). With alignment neutral, a
saturated base (fused RRF normalization hands rank-1-in-both-legs semanticScore=1.0 ->
calibratedBase=0.982) plus a single-token FTS hit ("favorite" is the only corpus occurrence)
stacking +0.08 leaves confidence at 1.0 before factors. Why it ranked #1 at all: "favorite"
is a unique token, so the lexical leg scored it max-normalized 1.0 and fusion crowned it.
The correct-subject memory pf_6_fact ranked #3 at rc 0.46 (LOW).

Why confidence cleared 0.90: agreement bonus pushed an already-saturated base to 1.0, and
the decisive-margin x1.05 bonus stacked on top; freshness (~0.95 factor) and speculative
(0.95) were too weak to pull it under the HIGH line. Signal that should have fired but did
not: topicalAlignment=0 mismatch penalty (x0.30 would have landed ~0.28 -> abstain).

## Case 2: ua_8_q - "What is Hanas favorite movie?"

- Verdict: `confident`, bestConfidence **0.9438** (HIGH), penalty -1.
- Wrong top-1: `pf_8_false` again - "My favorite snack is a peanut butter sandwich." At least
  this one is about Hana, but "favorite snack" does not answer "favorite movie".
- Expected: abstain. Hana's true fact ("Hana is allergic to peanuts") ranked #3 at rc 0.118.
- Evidence: identical shape to Case 1 - semantic=1.0, lexical rank=1/score=1.0,
  alignment=null, margin x1.05, decomposition identical (0.982+0.08 -> 1.0 -> x1.05 ->
  x0.9462 -> x0.95 = 0.9438).

Root cause: same mechanism as Case 1 - first-person falsehood wins every "favorite X"
query on keyword uniqueness of "favorite", then saturates the confidence stack. Here even
the entity actually matches (hana), so had the memory parsed, the attribute comparison
(food vs movie) would have produced alignment=0 and capped it. The parse miss on the
memory side is the entire failure. Candidate alignments were [null, 0, 0, 0, null]: the
guard worked on four candidates and was blind on the winner.

## Case 3: ua_13_q - "What is Mireias favorite book?"

- Verdict: `confident`, bestConfidence **0.9438** (HIGH), penalty -1.
- Wrong top-1: `pf_8_false` a third time - Hana's snack falsehood answering a question about
  Mireia. Correct-subject memory pf_13_fact ranked #4 at rc 0.446.
- Evidence/decomposition: byte-identical pattern to Cases 1-2 (sem=1.0, lex 1/1.0,
  alignment=null across ALL five candidates this time, decisive margin, 0.9438 final).

Root cause: identical mechanism, worst instance - three different unanswerable questions,
three different subjects, one first-person planted falsehood winning them all at HIGH
confidence purely through the "favorite" keyword monopoly plus saturated base + bonuses.

## Case 4: ua_16_q - "What pace does Pablo run?"

- Verdict: `confident`, bestConfidence **0.9849** (HIGH), penalty -1.
- Wrong top-1: `pf_16_fact` - "Pablo is training for his first marathon in Valencia." This is
  Pablo's REAL established fact, but it says nothing about pace - the fixture marks this
  question unanswerable. Runner-up pf_16_false ("My ironman triathlon in Kona...") sat at #4,
  rc 0.65 QUALIFIED.
- Evidence: semantic=1.0, lexical rank=1 score=1.0, freshness=0.958, alignment=null.
  Parsed query topic {pablo, pace}; parsed memory topic {pablo, **attribute:null**}.

Root cause: pure attribute-lexicon coverage gap. Entity extraction succeeded on BOTH sides
(pablo == pablo) - this is exactly the case B1 exists for - but neither "pace" nor any
memory-side cue ("training", "marathon"; note ATTR_KEYWORDS has jog/swim but not
run/race/marathon/training) maps to a bucket, so attributes are pace vs null and
`topicalAlignment` returns null (neutral by contract). Confidence then ran away further than
Cases 1-3 because freshness was higher (0.958): 0.982 + 0.08 = 1.0, x1.05 margin, x0.9874,
x0.95 = **0.9849**. Signal that should have fired: alignment=0 (same-entity-wrong-attribute);
even a milder "entity matched, attribute unknown" partial discount (x0.85) would have landed
0.85 -> qualified (hedged, penalty 0 instead of -1).

## Case 5: edge_noise_q - "What database does the atlas project use?"

- Verdict: `qualified` (0.8458 - NOT >= 0.90), penalty -1 via the scorer's wrong bucket.
- Wrong top-1: `fu_0_v2` - "The atlas project migrated its database from PostgreSQL to
  MySQL." (the OUTDATED v2 of atlas's db fact). Expected: `noise_relevant` - "...migrated its
  primary database to PostgreSQL 16 with pgvector..."
- Ranking context: FOUR near-duplicate memories all clamped to finalScore=1.0
  (fu_0_v2 boost 0.0601, noise_relevant 0.060044, fu_0_v1 sem=1.0 boost 0.0400, fu_0_v3).
  Order inside the clamp was decided by heuristic boosts worth ~0.02; the expected answer
  lost by roughly 0.00006 of boost. Semantic margin 0.016 -> ambiguous x0.90 correctly fired.
- Evidence (top-1): semantic=0.9839, lexical rank=2 score=0.968, alignment=NULL FOR EVERY
  candidate, contradictingCount=0 despite v1/v2/v3 being literal versions of one fact.

Root cause: two compounding failures. (1) Ranking-level: the fixture double-books the atlas
subject (noise_relevant duplicates fu_0's entity/domain) and finalScore saturation at 1.0
makes the ordering decision a coin flip between versions, resolved by tiny recency/entity
heuristics - fu_0_v2 (stale MySQL claim) won. (2) Confidence-level: the query parses to NULL
topic entirely - Family-A regex requires a CAPITALIZED entity run after "does", but the bench
writes subjects lowercase ("the atlas project") - so B1 is structurally blind to the whole
fact-update category. And with no association edges seeded between v1/v2/v3,
contradictingCount=0 and nothing invoked CONFLICT_CAP (0.55) on an actively contested fact.

---

## Synthesis

### Failure mechanisms (grouped)

**A. First-person memories defeat topical alignment (ua_6, ua_8, ua_13 - 3 of 5 cases).**
Sentences opening with "My ..." get entity=null from the memory-side parser; alignment stays
null; the mismatch guard is neutral-by-contract. Personal-agent corpora are full of
first-person notes, so this is the highest-frequency hole. Compounding: fused RRF gives
rank-1-in-both-legs results semanticScore=1.0, calibratedBase saturates (0.982), a single
unique-token FTS hit adds +0.08, and decisive-margin x1.05 stacks - the stack reaches 1.0
before any multiplicative factor can act, and none of the available factors (freshness ~x0.95,
speculative x0.95) is strong enough to drop below 0.90 alone.

**B. Attribute-lexicon coverage gaps (ua_16 - 1 case).**
Entity matching works; the attribute vocabulary does not (pace/run/marathon/training unmapped;
'run' absent while jog/swim exist). Null attribute forces full neutrality even when entities
match exactly - the precise scenario B1 targets slips through on vocabulary.

**C. Version-tie ranking + structurally blind query parser + missing supersession edges
(edge_noise_q - 1 case).**
Duplicate subjects in fixtures + finalScore clamp saturation turn ordering into heuristic
tie-breaks; lowercase query subjects make parseQueryTopic return null for the entire
fact-update category; unseeded associations mean contradictingCount=0 and CONFLICT_CAP never
engages on contested facts. Note this case is qualified-not-confident: the abstention floor
and ambiguity discount behaved correctly; only the exact-top-1 requirement failed.

Cross-cutting: agreement-bonus stacking on a saturated base. In all four confident cases the
additive phase ends AT 1.0 (cap), meaning every multiplicative guard that failed to fire was
the only thing standing between 0.90+ and honest doubt.

### Fix candidates (ranked by expected impact; NONE implemented here)

1. **First-person / pronoun subject resolution (Mechanism A)** - resolve sentence-initial
   "My/I ..." to the owning identity (author/user field or tags, which the bench already
   seeds per person) during memory-topic parsing, enabling same-entity/wrong-attribute
   detection. Kills 3/5 confident-wrongs outright (alignment=0 -> x0.30 lands each at ~0.28,
   deep abstain). Highest impact, moderate complexity (identity plumbing).
2. **Entity-matched null-attribute partial discount (Mechanism B)** - when entities MATCH but
   either side's attribute is null, return a weak-positive/mismatch-leaning value (e.g. apply
   TOPICAL_PARTIAL_FACTOR-style mild discount instead of perfect neutrality) rather than raw
   null. Generalizes beyond the lexicon; turns ua_16 from 0.985 confident into ~0.85 hedged.
   Needs care to preserve the "never penalize what cannot be parsed" contract - scoping the
   discount to entity-match-only keeps it principled.
3. **IDF-weighted lexical corroboration (cross-cutting)** - stop letting one low-IDF query
   token ("favorite") produce within-leg score 1.0 + LEXICAL_TOP3_BONUS; weight FTS agreement
   by term specificity, or cap the agreement bonus when the hit rests on a single shared
   token. Directly deflates the 0.982+0.08=1.0 saturation in Mechanism A cases and hardens
   every "generic word collision" path.
4. **Supersession linking on update chains (Mechanism C)** - seed/detect updates/supersedes
   associations among v1/v2/v3-style clusters (write-time or lazy at search time) so
   contradictingCount>0 triggers CONFLICT_CAP=0.55 on contested facts. Helps edge_noise_q
   (all four candidates would cap at 0.55 -> verdict flips toward abstain/hedge) and lifts
   the broader fact-update category, not just the bench.
5. **Fixture hygiene: dedupe the atlas subject (test-only)** - give noise_relevant its own
   entity so edge_noise_q measures noise robustness instead of version tie-breaks. Zero risk;
   changes baseline numbers (re-baseline required).
6. **Tie-aware serving under clamp saturation (ranking-level, riskier)** - when multiple
   results share final==1.0, break ties on semanticScore (fu_0_v1 sem=1.0 outranks fu_0_v2
   sem=0.984) instead of heuristic boost dust. Touches serving order; gate behind a flag.

Items 1-3 are confidence-layer fixes (no ranking change, consistent with B1/B2 design
constraints); items 4-6 change ranking/corpus behavior and need their own benches.
