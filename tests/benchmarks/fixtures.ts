/**
 * Memory benchmark fixtures (Batch 9, adversarial suite Task B12-3).
 *
 * Deterministic, synthetic corpus modeling four conflict categories for
 * measuring contradiction handling, temporal reasoning, conditional retrieval,
 * and appropriate abstention.
 *
 * Section 4b adds the adversarial unanswerable suite: 80 queries across 10
 * trap classes (see TRAP_CLASSES), each carrying an integrityGuard that
 * bench-integrity.test.ts uses to prove no active memory answers it.
 *
 * Every memory carries metadata.benchId; the runner maps stored UUIDs back
 * to bench ids for scoring (search results do not expose metadata).
 *
 * Scoring approximation (LLM-free, documented in the runner): a result is
 * judged by WHICH memory ranked and its calibrated confidence tier â€” we do
 * not simulate an answer model. "Confident-wrong" means the false/absent
 * memory ranked top-1 at QUALIFIED+ confidence.
 */

export interface BenchMemory {
  benchId: string;
  type: 'fact' | 'decision' | 'preference' | 'observation';
  tags: string[];
  content: string;
  /** Optional ISO timestamp override for bi-temporal point-in-time scenarios. */
  createdAt?: string;
}

export interface BenchQuery {
  benchId: string;
  category: BenchCategory;
  query: string;
  /** benchIds that must rank top-1 for full credit. */
  expectTop1?: string[];
  /** benchIds that earn partial credit when present in top-3. */
  expectTop3?: string[];
  /** Top-1 records that explicitly state the historical answer without being the old version itself. */
  supportingEvidenceTop1?: string[];
  /** For unanswerable queries: any hit at/above this tier counts as confident-wrong. */
  wrongIfTop1?: string[];
  /**
   * Adversarial sub-class (Task B12-3). Only set on `unanswerable` queries;
   * purely descriptive for scoring (the switch is untouched) and used by
   * run-memory-bench.ts for the per-trap-class report breakdown.
   */
  trapClass?: TrapClass;
  /**
   * Machine-checkable proof inputs for bench-integrity.test.ts: they let the
   * test PROVE against the seeded corpus that no active memory contains a
   * direct answer to this query. Absent on legacy fixtures.
   */
  integrityGuard?: AdversarialGuard;
}

/**
 * Adversarial trap classes (Task B12-3). Each name matches a distinct
 * failure shape from CONFIDENT-WRONG-AUTOPSY.md and general abstention
 * literature; every class ships >= 8 queries.
 */
export const TRAP_CLASSES = [
  'entity-only',
  'wrong-attribute',
  'wrong-relationship',
  'semantic-near-miss',
  'temporal-mismatch',
  'superseded-fact-current-query',
  'contradictory-evidence',
  'absent-entity',
  'partial-match',
  'multi-hop-trap',
] as const;

export type TrapClass = (typeof TRAP_CLASSES)[number];

/**
 * Per-query verification contract consumed by bench-integrity.test.ts.
 *
 * Token semantics (word-boundary, case-insensitive, exact word - no prefix
 * matching, so "manage" does not hit "management"):
 *  - entityTokens identify WHO/WHAT the query asks about.
 *  - attrKeywords identify the asked-but-unstored ATTRIBUTE.
 *  - Default rule: NO ACTIVE memory may contain (any entityToken) AND
 *    (any attrKeyword). Classes override or extend this via the flags below.
 */
export interface AdversarialGuard {
  entityTokens: string[];
  attrKeywords: string[];
  /**
   * multi-hop only: each inner list must appear (ALL tokens) inside SOME
   * single active memory - proving the composing halves exist separately -
   * while the join (entity + attribute) stays prohibited everywhere.
   */
  hopHalfTokens?: string[][];
  /**
   * contradictory-evidence only: benchIds of the designed conflict pair.
   * Exactly these two memories are allowed to match entity+attribute; the
   * test asserts both are active and their contents disagree.
   */
  exemptBenchIds?: string[];
  /**
   * superseded-fact-current-query only: after stripping "instead of ..."
   * clauses, EVERY memory matching entity+attribute must have seeded status
   * superseded (the successor must not restate the queried attribute).
   */
  requireAllSuperseded?: boolean;
  /** absent-entity only: entityTokens must appear in ZERO rows, any status. */
  requireEntityAbsent?: boolean;
  /**
   * temporal-mismatch only: ISO instant the query asks about. Every row
   * (ANY status) matching entity+attribute must have valid_from AFTER this
   * instant - i.e. no version of the chain was valid at the asked time.
   */
  askedTimeISO?: string;
}

export type BenchCategory = 'fact-update' | 'planted-falsehood' | 'conditional-preference' | 'unanswerable' | 'edge-empty' | 'edge-long' | 'edge-special-chars' | 'edge-noise' | 'edge-partial-match';

export const BENCH_CATEGORIES: BenchCategory[] = [
  'fact-update',
  'planted-falsehood',
  'conditional-preference',
  'unanswerable',
  'edge-empty',
  'edge-long',
  'edge-special-chars',
  'edge-noise',
  'edge-partial-match',
];

// â”€â”€â”€ 1. Fact updates (dynamic conflict): 30 subjects Ã— 3 versions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Version-chain realism note (Batch B12-2b Fix C): the bench seeds through
 * the REAL write path (`client.remember`), whose contradiction resolver
 * supersedes an active predecessor when the new row carries an update
 * indicator ("now", "instead of", ...) AND its extracted subject overlaps
 * the old row's subject by Jaccard > 0.5. The v2/v3 phrasings below are
 * modeled on real update flows ("X now uses B instead of A") so seeding
 * produces genuine superseded status + `updates` association edges and
 * exactly ONE active version per chain at query time - instead of three
 * tied active duplicates. Consecutive-pair similarity was verified against
 * the resolver's exact math (see tests/benchmarks/bench-integrity.test.ts).
 * Grove's final version says "Fly" without the dot on purpose: the
 * resolver's subject extractor has no abbreviation guard and splits
 * sentences on periods, so "Fly.io" truncates the subject mid-name.
 */

interface UpdateSubject {
  subject: string;
  domain: string;
  v1: string;
  v2: string;
  v3: string;
  queryCurrent: string;
  queryPast: string;
  latestVersionAnswersPastQuery?: boolean;
}

const UPDATE_SUBJECTS: UpdateSubject[] = [
  { subject: 'atlas', domain: 'database', v1: 'The atlas project uses PostgreSQL as its primary database.', v2: 'The atlas project now uses MySQL as its primary database instead of PostgreSQL.', v3: 'The atlas project now uses PostgreSQL again as its primary database instead of MySQL.', queryCurrent: 'What database does the atlas project use?', queryPast: 'What database did the atlas project use before the MySQL experiment?' },
  { subject: 'beacon', domain: 'framework', v1: 'The beacon service is built with Express.', v2: 'The beacon service is now built with Fastify instead of Express.', v3: 'The beacon service is now built with Hono instead of Fastify after evaluation.', queryCurrent: 'What framework does the beacon service use?', queryPast: 'What framework did the beacon service use before Hono?' },
  { subject: 'cedar', domain: 'package manager', v1: 'The cedar repo uses npm for dependency management.', v2: 'The cedar repo now uses yarn for dependency management instead of npm.', v3: 'The cedar repo now uses pnpm for dependency management instead of yarn.', queryCurrent: 'Which package manager does the cedar repo use?', queryPast: 'Which package manager did the cedar repo use before pnpm?' },
  { subject: 'dune', domain: 'deployment', v1: 'Dune deploys to a single VPS via docker compose.', v2: 'Dune now deploys to Kubernetes instead of a single VPS docker compose stack.', v3: 'Dune now deploys via docker compose on a beefier host instead of Kubernetes.', queryCurrent: 'How does Dune deploy?', queryPast: 'How did Dune deploy before the Kubernetes move?' },
  { subject: 'ember', domain: 'auth provider', v1: 'Ember uses Auth0 for authentication.', v2: 'Ember now uses Clerk for authentication instead of Auth0.', v3: 'Ember now uses a self-hosted Ory stack for authentication instead of Clerk.', queryCurrent: 'What auth provider does Ember use?', queryPast: 'What auth provider did Ember use before Ory?' },
  { subject: 'flint', domain: 'language', v1: 'The flint parser is written in Python.', v2: 'The flint parser is now written in Rust instead of Python.', v3: 'The flint parser is now written partly in Zig instead of only Rust.', queryCurrent: 'What language is the flint parser written in?', queryPast: 'What language was the flint parser originally written in?' },
  { subject: 'grove', domain: 'hosting', v1: 'Grove is hosted on AWS us-east-1.', v2: 'Grove is now hosted on GCP instead of AWS us-east-1.', v3: 'Grove is now hosted on Fly instead of GCP.', queryCurrent: 'Where is Grove hosted?', queryPast: 'Where was Grove hosted before Fly.io?' },
  { subject: 'harbor', domain: 'ci', v1: 'Harbor runs its CI on Jenkins.', v2: 'Harbor now runs its CI on CircleCI instead of Jenkins.', v3: 'Harbor now runs its CI on GitHub Actions instead of CircleCI.', queryCurrent: 'What CI does Harbor run?', queryPast: 'What CI did Harbor run before GitHub Actions?' },
  { subject: 'ignite', domain: 'state management', v1: 'Ignite uses Redux for state management.', v2: 'Ignite now uses Zustand for state management instead of Redux.', v3: 'Ignite now uses Jotai for atomic state instead of Zustand patterns.', queryCurrent: 'What state management does Ignite use?', queryPast: 'What state management did Ignite use before Jotai?' },
  { subject: 'juno', domain: 'css', v1: 'Juno styles with plain CSS.', v2: 'Juno now styles with Sass instead of plain CSS.', v3: 'Juno now styles with Tailwind instead of custom Sass.', queryCurrent: 'How does Juno handle styling?', queryPast: 'How did Juno handle styling before Tailwind?', latestVersionAnswersPastQuery: true },
  { subject: 'krypton', domain: 'queue', v1: 'Krypton processes jobs with RabbitMQ.', v2: 'Krypton now processes jobs with Sidekiq instead of RabbitMQ.', v3: 'Krypton now processes jobs with NATS JetStream instead of Sidekiq.', queryCurrent: 'What queue does Krypton use?', queryPast: 'What queue did Krypton use before NATS?' },
  { subject: 'lumen', domain: 'observability', v1: 'Lumen monitors its stack with Datadog.', v2: 'Lumen now monitors its stack with New Relic instead of Datadog.', v3: 'Lumen now monitors its stack with self-hosted Grafana and Loki instead of New Relic.', queryCurrent: 'What observability stack does Lumen use?', queryPast: 'What observability did Lumen use before Grafana?' },
  { subject: 'mesa', domain: 'orm', v1: 'Mesa accesses data through raw SQL.', v2: 'Mesa now accesses data through Prisma instead of raw SQL.', v3: 'Mesa now accesses data through Drizzle instead of Prisma for edge compatibility.', queryCurrent: 'What ORM does Mesa use?', queryPast: 'What ORM did Mesa use before Drizzle?' },
  { subject: 'nimbus', domain: 'testing', v1: 'Nimbus tests with Mocha.', v2: 'Nimbus now tests with Jest instead of Mocha.', v3: 'Nimbus now tests with Vitest instead of Jest across its suite.', queryCurrent: 'What test runner does Nimbus use?', queryPast: 'What test runner did Nimbus use before Vitest?' },
  { subject: 'onyx', domain: 'cache', v1: 'Onyx caches with Memcached.', v2: 'Onyx now caches with Redis instead of Memcached.', v3: 'Onyx now caches with Dragonfly instead of Redis as primary.', queryCurrent: 'What cache does Onyx use?', queryPast: 'What cache did Onyx use before Dragonfly?' },
  { subject: 'prism', domain: 'bundler', v1: 'Prism bundles with Webpack.', v2: 'Prism now bundles with Rollup instead of Webpack.', v3: 'Prism now bundles with tsup instead of Rollup for library builds.', queryCurrent: 'What bundler does Prism use?', queryPast: 'What bundler did Prism use before tsup?' },
  { subject: 'quartz', domain: 'docs', v1: 'Quartz documents with Jekyll.', v2: 'Quartz now documents with Docusaurus instead of Jekyll.', v3: 'Quartz now documents with Starlight instead of Docusaurus.', queryCurrent: 'What docs tool does Quartz use?', queryPast: 'What docs tool did Quartz use before Starlight?' },
  { subject: 'ridge', domain: 'api style', v1: 'Ridge exposes a REST API.', v2: 'Ridge now exposes a GraphQL API instead of REST.', v3: 'Ridge now exposes a REST API again instead of GraphQL for internal services.', queryCurrent: 'What API style does Ridge use?', queryPast: 'What API style did Ridge use before the REST return?' },
  { subject: 'slate', domain: 'editor', v1: 'Slate uses CKEditor as its editor.', v2: 'Slate now uses TipTap as its editor instead of CKEditor.', v3: 'Slate now uses its own Lexical-based editor instead of TipTap.', queryCurrent: 'What editor does Slate use?', queryPast: 'What editor did Slate use before Lexical?' },
  { subject: 'tundra', domain: 'search', v1: 'Tundra searches with Solr.', v2: 'Tundra now searches with Elasticsearch instead of Solr.', v3: 'Tundra now searches with Meilisearch instead of Elasticsearch for product search.', queryCurrent: 'What search engine does Tundra use?', queryPast: 'What search engine did Tundra use before Meilisearch?' },
  { subject: 'umbra', domain: 'payments', v1: 'Umbra handles its payments through Braintree.', v2: 'Umbra now handles its payments through Stripe instead of Braintree.', v3: 'Umbra now handles its payments through Paddle instead of Stripe as merchant of record.', queryCurrent: 'What payments provider does Umbra use?', queryPast: 'What payments provider did Umbra use before Paddle?' },
  { subject: 'vessel', domain: 'container runtime', v1: 'Vessel runs Docker containers.', v2: 'Vessel now runs containerd containers instead of Docker.', v3: 'Vessel now runs Podman containers instead of containerd for rootless workloads.', queryCurrent: 'What container runtime does Vessel use?', queryPast: 'What container runtime did Vessel use before Podman?' },
  { subject: 'willow', domain: 'frontend', v1: 'Willow renders with AngularJS.', v2: 'Willow now renders with React instead of AngularJS.', v3: 'Willow now renders design system surfaces with SolidJS instead of React.', queryCurrent: 'What frontend framework does Willow use?', queryPast: 'What frontend framework did Willow use before SolidJS?' },
  { subject: 'xenon', domain: 'messaging', v1: 'Xenon sends email via SendGrid.', v2: 'Xenon now sends email via Mailgun instead of SendGrid.', v3: 'Xenon now sends transactional email via Resend instead of Mailgun.', queryCurrent: 'What email provider does Xenon use?', queryPast: 'What email provider did Xenon use before Resend?' },
  { subject: 'yarrow', domain: 'scheduling', v1: 'Yarrow schedules with cron.', v2: 'Yarrow now schedules with Temporal instead of cron.', v3: 'Yarrow now schedules with Inngest instead of Temporal.', queryCurrent: 'What scheduler does Yarrow use?', queryPast: 'What scheduler did Yarrow use before Inngest?' },
  { subject: 'zephyr', domain: 'storage', v1: 'Zephyr stores its files on S3.', v2: 'Zephyr now stores its files on GCS instead of S3.', v3: 'Zephyr now stores its files on Cloudflare R2 instead of GCS.', queryCurrent: 'What object storage does Zephyr use?', queryPast: 'What object storage did Zephyr use before R2?' },
  { subject: 'basalt', domain: 'linter', v1: 'Basalt lints with TSLint.', v2: 'Basalt now lints with ESLint instead of TSLint.', v3: 'Basalt now lints with Oxlint instead of ESLint for speed.', queryCurrent: 'What linter does Basalt use?', queryPast: 'What linter did Basalt use before Oxlint?' },
  { subject: 'cobalt', domain: 'runtime', v1: 'Cobalt runs on Node 16.', v2: 'Cobalt now runs on Node 20 instead of Node 16.', v3: 'Cobalt now runs its runtime on Bun instead of Node.', queryCurrent: 'What runtime does Cobalt use?', queryPast: 'What runtime did Cobalt use before Bun?' },
  { subject: 'deltas', domain: 'analytics', v1: 'Deltas tracks product events with the Segment analytics stack.', v2: 'Deltas now tracks product events with Jitsu instead of the Segment analytics stack.', v3: 'Deltas now tracks product events with the PostHog analytics stack instead of Jitsu.', queryCurrent: 'What analytics provider does Deltas use?', queryPast: 'What analytics provider did Deltas use before PostHog?' },
  { subject: 'estuary', domain: 'secrets', v1: 'Estuary stores its secrets in Vault.', v2: 'Estuary now stores its secrets in AWS Secrets Manager instead of Vault.', v3: 'Estuary now stores its secrets in Infisical instead of AWS Secrets Manager.', queryCurrent: 'What secrets manager does Estuary use?', queryPast: 'What secrets manager did Estuary use before Infisical?' },
];

export function buildFactUpdateMemories(): BenchMemory[] {
  const memories: BenchMemory[] = [];
  UPDATE_SUBJECTS.forEach((s, idx) => {
    memories.push({ benchId: `fu_${idx}_v1`, type: 'fact', tags: [s.subject, s.domain], content: s.v1, createdAt: isoDay(0, idx) });
    memories.push({ benchId: `fu_${idx}_v2`, type: 'fact', tags: [s.subject, s.domain], content: s.v2, createdAt: isoDay(40, idx) });
    memories.push({ benchId: `fu_${idx}_v3`, type: 'fact', tags: [s.subject, s.domain], content: s.v3, createdAt: isoDay(80, idx) });
  });
  return memories;
}

export function buildFactUpdateQueries(): BenchQuery[] {
  const queries: BenchQuery[] = [];
  UPDATE_SUBJECTS.forEach((s, idx) => {
    queries.push({ benchId: `fu_${idx}_q_current`, category: 'fact-update', query: s.queryCurrent, expectTop1: [`fu_${idx}_v3`], expectTop3: [`fu_${idx}_v3`, `fu_${idx}_v2`] });
    queries.push({
      benchId: `fu_${idx}_q_past`,
      category: 'fact-update',
      query: s.queryPast,
      expectTop1: [`fu_${idx}_v1`],
      expectTop3: [`fu_${idx}_v1`, `fu_${idx}_v2`],
      ...(s.latestVersionAnswersPastQuery ? { supportingEvidenceTop1: [`fu_${idx}_v3`] } : {}),
    });
  });
  return queries;
}

// â”€â”€â”€ 2. Planted falsehoods (static conflict): 20 subjects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface FalsehoodSubject {
  person: string;
  established: string;
  falseClaim: string;
  query: string;
}

const FALSEHOOD_SUBJECTS: FalsehoodSubject[] = [
  { person: 'marisol', established: 'Marisol graduated from Cal State Long Beach with a degree in statistics.', falseClaim: 'During my grad years at MIT I focused on statistical physics.', query: 'Where did Marisol study statistics?' },
  { person: 'kenji', established: 'Kenji was born in Osaka and lived there until age twelve.', falseClaim: 'Growing up in Kyoto shaped my early years.', query: 'Where did Kenji grow up?' },
  { person: 'priya', established: 'Priya drives a 2019 Volvo V60.', falseClaim: 'My Tesla Model 3 is great for road trips.', query: 'What car does Priya drive?' },
  { person: 'tomas', established: 'Tomas has worked at the fisheries institute since 2015.', falseClaim: 'My decade at the merchant marine academy taught me navigation.', query: 'Where does Tomas work?' },
  { person: 'aiko', established: 'Aiko plays competitive badminton on weekends.', falseClaim: 'My national-level swimming career takes most of my free time.', query: 'What sport does Aiko play competitively?' },
  { person: 'dmitri', established: 'Dmitri owns a tabby cat named Basil.', falseClaim: 'My golden retriever Biscuit loves the park.', query: 'What pet does Dmitri own?' },
  { person: 'fatima', established: 'Fatima is a pediatric nurse at St. Marys hospital.', falseClaim: 'My surgical residency at Johns Hopkins keeps me busy.', query: 'What is Fatimas profession?' },
  { person: 'gustav', established: 'Gustav speaks fluent Swedish and German.', falseClaim: 'My native Portuguese helps in Sao Paulo business.', query: 'What languages does Gustav speak?' },
  { person: 'hana', established: 'Hana is allergic to peanuts.', falseClaim: 'My favorite snack is a peanut butter sandwich.', query: 'What food allergy does Hana have?' },
  { person: 'ivan', established: 'Ivan lives in a two-bedroom apartment in Riga.', falseClaim: 'My villa on the Amalfi coast overlooks the sea.', query: 'Where does Ivan live?' },
  { person: 'june', established: 'June studied civil engineering at Seoul National University.', falseClaim: 'My architecture degree from ETH Zurich was demanding.', query: 'What did June study?' },
  { person: 'kwame', established: 'Kwame runs a cocoa farm in Ghana.', falseClaim: 'My vineyard in Bordeaux produces red wine.', query: 'What does Kwame farm?' },
  { person: 'lars', established: 'Lars is a professional wind-turbine technician.', falseClaim: 'My job as a nuclear plant operator requires clearance.', query: 'What is Lars occupation?' },
  { person: 'mireia', established: 'Mireia volunteers at the animal shelter every Saturday.', falseClaim: 'My weekend golf club membership is my main hobby.', query: 'What does Mireia do on weekends?' },
  { person: 'nikolai', established: 'Nikolai collects vintage film cameras.', falseClaim: 'My rare stamp collection fills several albums.', query: 'What does Nikolai collect?' },
  { person: 'olga', established: 'Olga teaches high-school chemistry.', falseClaim: 'My law practice in Warsaw specializes in patents.', query: 'What does Olga teach?' },
  { person: 'pablo', established: 'Pablo is training for his first marathon in Valencia.', falseClaim: 'My ironman triathlon in Kona is next month.', query: 'What race is Pablo training for?' },
  { person: 'qing', established: 'Qing plays the erhu in a folk ensemble.', falseClaim: 'My conservatory training was on the cello.', query: 'What instrument does Qing play?' },
  { person: 'rosa', established: 'Rosa owns a small bakery specializing in sourdough.', falseClaim: 'My sushi restaurant in Lisbon is Michelin listed.', query: 'What business does Rosa own?' },
  { person: 'sven', established: 'Sven is completing a PhD on Arctic sea ice.', falseClaim: 'My postdoc on tropical coral reefs started last year.', query: 'What is Sven researching?' },
];

export function buildFalsehoodMemories(): BenchMemory[] {
  const memories: BenchMemory[] = [];
  FALSEHOOD_SUBJECTS.forEach((s, idx) => {
    memories.push({ benchId: `pf_${idx}_fact`, type: 'fact', tags: [s.person], content: s.established, createdAt: isoDay(10, idx) });
    memories.push({ benchId: `pf_${idx}_false`, type: 'observation', tags: [s.person], content: s.falseClaim, createdAt: isoDay(50, idx) });
  });
  return memories;
}

export function buildFalsehoodQueries(): BenchQuery[] {
  return FALSEHOOD_SUBJECTS.map((s, idx) => ({
    benchId: `pf_${idx}_q`,
    category: 'planted-falsehood' as const,
    query: s.query,
    expectTop1: [`pf_${idx}_fact`],
    wrongIfTop1: [`pf_${idx}_false`],
  }));
}

// â”€â”€â”€ 3. Condition-bound preferences: 15 subjects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface PreferenceSubject {
  person: string;
  preference: string;
  condition: string;
  queryWithCondition: string;
  queryWithoutCondition: string;
}

const PREFERENCE_SUBJECTS: PreferenceSubject[] = [
  { person: 'amara', preference: 'listens to audiobooks for professional study', condition: 'while commuting', queryWithCondition: 'What does Amara listen to while commuting?', queryWithoutCondition: 'What does Amara like listening to?' },
  { person: 'bruno', preference: 'drinks decaf espresso', condition: 'in the evening', queryWithCondition: 'What does Bruno drink in the evening?', queryWithoutCondition: 'What does Bruno like to drink?' },
  { person: 'chiara', preference: 'works from the library', condition: 'during exam season', queryWithCondition: 'Where does Chiara work during exam season?', queryWithoutCondition: 'Where does Chiara like to work?' },
  { person: 'dario', preference: 'runs trail loops', condition: 'when the weather is dry', queryWithCondition: 'Where does Dario run when the weather is dry?', queryWithoutCondition: 'How does Dario like to exercise?' },
  { person: 'elif', preference: 'cooks vegetarian meals', condition: 'on weeknights', queryWithCondition: 'What does Elif cook on weeknights?', queryWithoutCondition: 'What does Elif like to cook?' },
  { person: 'farid', preference: 'takes the train instead of flying', condition: 'for trips under 600km', queryWithCondition: 'How does Farid travel for short trips?', queryWithoutCondition: 'How does Farid like to travel?' },
  { person: 'greta', preference: 'reads physical books', condition: 'before bed', queryWithCondition: 'What does Greta read before bed?', queryWithoutCondition: 'What does Greta read?' },
  { person: 'hugo', preference: 'uses a standing desk', condition: 'during morning work sessions', queryWithCondition: 'What desk setup does Hugo use in the morning?', queryWithoutCondition: 'What is Hugos desk setup?' },
  { person: 'ines', preference: 'bikes to the office', condition: 'outside of winter', queryWithCondition: 'How does Ines get to the office outside of winter?', queryWithoutCondition: 'How does Ines commute?' },
  { person: 'jonas', preference: 'drinks green tea', condition: 'while coding', queryWithCondition: 'What does Jonas drink while coding?', queryWithoutCondition: 'What does Jonas like to drink?' },
  { person: 'kaya', preference: 'jogs at sunrise', condition: 'on weekends', queryWithCondition: 'When does Kaya jog on weekends?', queryWithoutCondition: 'Does Kaya exercise?' },
  { person: 'leon', preference: 'writes notes on paper', condition: 'during interviews', queryWithCondition: 'How does Leon take notes during interviews?', queryWithoutCondition: 'How does Leon take notes?' },
  { person: 'maja', preference: 'orders salad for lunch', condition: 'on busy days', queryWithCondition: 'What does Maja order for lunch on busy days?', queryWithoutCondition: 'What does Maja eat for lunch?' },
  { person: 'nils', preference: 'watches documentaries', condition: 'on long flights', queryWithCondition: 'What does Nils watch on long flights?', queryWithoutCondition: 'What does Nils watch?' },
  { person: 'olive', preference: 'meditates for ten minutes', condition: 'before standup meetings', queryWithCondition: 'What does Olive do before standup meetings?', queryWithoutCondition: 'Does Olive meditate?' },
];

export function buildPreferenceMemories(): BenchMemory[] {
  return PREFERENCE_SUBJECTS.map((s, idx) => ({
    benchId: `cp_${idx}_pref`,
    type: 'preference' as const,
    tags: [s.person, 'preference'],
    content: `${capitalize(s.person)} ${s.preference} ${s.condition}.`,
    createdAt: isoDay(20, idx),
  }));
}

export function buildPreferenceQueries(): BenchQuery[] {
  const queries: BenchQuery[] = [];
  PREFERENCE_SUBJECTS.forEach((s, idx) => {
    queries.push({ benchId: `cp_${idx}_q_with`, category: 'conditional-preference', query: s.queryWithCondition, expectTop1: [`cp_${idx}_pref`], expectTop3: [`cp_${idx}_pref`] });
    queries.push({ benchId: `cp_${idx}_q_without`, category: 'conditional-preference', query: s.queryWithoutCondition, expectTop3: [`cp_${idx}_pref`] });
  });
  return queries;
}

// â”€â”€â”€ 4. Unanswerable (abstention): 20 queries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildUnanswerableQueries(): BenchQuery[] {
  const subjects = [
    'What is Marisol favorite wine?', 'What phone does Kenji use?', 'What is Priyas shoe size?',
    'Where did Tomas go to primary school?', 'What is Aikos blood type?', 'What car does Dmitri want to buy?',
    'What is Fatimas favorite color?', 'Which instruments does Gustav play?', 'What is Hanas favorite movie?',
    'What is Ivan salary?', 'Where does June live now?', 'What is Kwames wifes name?',
    'What team does Lars support?', 'What is Mireias favorite book?', 'What camera does Nikolai shoot with?',
    'What is Olgas favorite chemistry topic?', 'What pace does Pablo run?', 'What is Qings favorite erhu piece?',
    'Where does Rosa get her flour?', 'What is Svens favorite season?',
  ];
  return subjects.map((q, idx) => ({ benchId: `ua_${idx}_q`, category: 'unanswerable' as const, query: q }));
}

// ──── 4b. Adversarial unanswerables (Task B12-3): 10 trap classes x 8 ──────

/**
 * The legacy unanswerables above are all ONE shape: an absent attribute
 * about a named person. This block stress-tests GENERALIZATION with eight
 * queries per adversarial trap class (80 new; 100 unanswerables total).
 * Class designs trace directly to CONFIDENT-WRONG-AUTOPSY.md failure shapes:
 *
 *   entity-only / wrong-attribute   Mechanism B territory (attribute gaps)
 *   semantic-near-miss              Mechanism A territory (lexical monopoly)
 *   superseded-fact-current-query   Mechanism C territory (version chains)
 *   contradictory-evidence          dual-active conflicts, ideal = hedge
 *   temporal-mismatch               point-in-time queries with no valid version
 *
 * INTEGRITY CONTRACT: every query carries an integrityGuard that
 * bench-integrity.test.ts uses to PROVE against the seeded corpus that no
 * active memory contains a direct answer. Guards use exact word-boundary
 * matching so "manage" never hits "management" and "car" never hits "career".
 */

/**
 * Superseded-current chains: v2 carries an update indicator ("now",
 * "instead of") and > 0.5 subject Jaccard with v1 (mirroring the resolver
 * math asserted in bench-integrity.test.ts), so seeding supersedes v1 and
 * leaves v2 active WITHOUT restating the queried attribute. The queried
 * attribute word appears ONLY in v1 - asking its current value has no
 * active answer.
 */
interface SupersededChain {
  person: string;
  v1: string;
  v2: string;
}

const SUPERSEDED_CHAINS: SupersededChain[] = [
  // NOTE: v1 wording avoids intra-sentence punctuation around the attribute
  // word - extractSubject/calculateSimilarity split on whitespace only, so
  // "car," (comma attached) would never equal "car" and the v1->v2 subject
  // Jaccard would drop below the 0.5 supersession threshold (caught by
  // bench-integrity.test.ts on first run).
  { person: 'talia', v1: 'Talia parks her car at the office garage.', v2: 'Talia now parks her bicycle at the office garage instead of the car.' },
  { person: 'mateo', v1: 'Mateo writes web apps with Django at the startup lab.', v2: 'Mateo now writes apps with Go at the startup lab instead of Django.' },
  { person: 'renata', v1: 'Renata teaches yoga at the riverside studio.', v2: 'Renata now teaches pilates at the riverside studio instead of yoga.' },
  { person: 'oscar', v1: 'Oscar brews lager at the dockside brewery.', v2: 'Oscar now brews stout at the dockside brewery instead of lager.' },
  { person: 'nadia', v1: 'Nadia paints murals with acrylics downtown.', v2: 'Nadia now paints murals with spray paint downtown instead of acrylics.' },
  { person: 'felix', v1: 'Felix grows tomatoes in the rooftop greenhouse.', v2: 'Felix now grows peppers in the rooftop greenhouse instead of tomatoes.' },
  { person: 'iveta', v1: 'Iveta plays violin in the civic orchestra.', v2: 'Iveta now plays viola in the civic orchestra instead of violin.' },
  { person: 'bram', v1: 'Bram roasts colombian beans for his cafe.', v2: 'Bram now roasts ethiopian beans for his cafe instead of colombian ones.' },
];

/**
 * Designed conflict pairs: two statements that stay ACTIVE simultaneously
 * (no update indicator, no negation, no opposite-keyword pair, subject
 * similarity below every supersession scenario) while disagreeing on one
 * attribute. Ideal system behavior on the paired query is qualified/abstain,
 * never confident. Fixture-only data, as sanctioned by the task spec.
 */
interface ConflictPair {
  id: string;
  a: string;
  b: string;
}

const CONFLICT_PAIRS: ConflictPair[] = [
  { id: 'yara', a: 'Yara books client meetings on Tuesdays.', b: 'Yara schedules client meetings on Thursdays.' },
  { id: 'zaid', a: 'Zaid reports to the Lisbon office.', b: 'Zaid reports to the Porto office.' },
  { id: 'cleo', a: 'Cleo keeps the spare keys in the kitchen drawer.', b: 'Cleo keeps the spare keys in the hallway cabinet.' },
  { id: 'anwar', a: 'Anwar sits on the fourth floor.', b: 'Anwar sits on the sixth floor.' },
  { id: 'lidia', a: 'Lidia runs sprint reviews on Monday mornings.', b: 'Lidia runs sprint reviews on Wednesday mornings.' },
  { id: 'berlin-accounts', a: 'Petra manages the Berlin accounts.', b: 'Sofia manages the Berlin accounts.' },
  { id: 'ruslan', a: 'Ruslan stores backups on the local NAS.', b: 'Ruslan stores backups with a cloud provider.' },
  { id: 'sanna', a: 'Sannas team meets at nine sharp.', b: 'Sannas team meets at half past nine.' },
];

export function conflictPairBenchIds(id: string): [string, string] {
  return [`am_con_${id}_a`, `am_con_${id}_b`];
}

/** Deterministic June-2026 timestamps, 3h apart, unique per adversarial row. */
function advIso(seq: number): string {
  return new Date(Date.UTC(2026, 5, 1, 0, seq * 180)).toISOString();
}

/**
 * ORDER MATTERS: these rows seed BEFORE the main corpus. The contradiction
 * resolver scans only the first 100 ACTIVE rows (rowid order) when deciding
 * supersessions, so seeding the chains first guarantees each v1 sits inside
 * the scan window when its v2 arrives, and main-corpus writes cannot
 * accidentally interact with them (fresh subjects verified dissimilar).
 */
export function buildAdversarialMemories(): BenchMemory[] {
  const memories: BenchMemory[] = [];
  let seq = 0;
  for (const c of SUPERSEDED_CHAINS) {
    memories.push({ benchId: `am_sup_${c.person}_v1`, type: 'fact', tags: [c.person], content: c.v1, createdAt: advIso(seq++) });
    memories.push({ benchId: `am_sup_${c.person}_v2`, type: 'fact', tags: [c.person], content: c.v2, createdAt: advIso(seq++) });
  }
  for (const p of CONFLICT_PAIRS) {
    const [idA, idB] = conflictPairBenchIds(p.id);
    memories.push({ benchId: idA, type: 'fact', tags: ['conflict-pair', p.id], content: p.a, createdAt: advIso(seq++) });
    memories.push({ benchId: idB, type: 'fact', tags: ['conflict-pair', p.id], content: p.b, createdAt: advIso(seq++) });
  }
  return memories;
}

interface AdversarialSpec {
  trapClass: TrapClass;
  idx: number;
  query: string;
  guard: AdversarialGuard;
}

export function buildAdversarialUnanswerables(): BenchQuery[] {
  const specs: AdversarialSpec[] = [
    // ── entity-only: entity stored under a DIFFERENT attribute only ──
    { trapClass: 'entity-only', idx: 0, query: 'What is Kenjis favorite food?', guard: { entityTokens: ['kenji'], attrKeywords: ['favorite', 'food'] } },
    { trapClass: 'entity-only', idx: 1, query: 'How many siblings does Priya have?', guard: { entityTokens: ['priya'], attrKeywords: ['sibling', 'siblings'] } },
    { trapClass: 'entity-only', idx: 2, query: 'What is Marisols shoe size?', guard: { entityTokens: ['marisol'], attrKeywords: ['shoe', 'size'] } },
    { trapClass: 'entity-only', idx: 3, query: 'In which city does Tomas live?', guard: { entityTokens: ['tomas'], attrKeywords: ['city', 'live', 'lives'] } },
    { trapClass: 'entity-only', idx: 4, query: 'What is Aikos favorite movie?', guard: { entityTokens: ['aiko'], attrKeywords: ['movie', 'film'] } },
    { trapClass: 'entity-only', idx: 5, query: 'Where did Dmitri go on his last vacation?', guard: { entityTokens: ['dmitri'], attrKeywords: ['vacation'] } },
    { trapClass: 'entity-only', idx: 6, query: 'What is Fatimas native language?', guard: { entityTokens: ['fatima'], attrKeywords: ['language', 'native'] } },
    { trapClass: 'entity-only', idx: 7, query: 'Which instrument does Hana play?', guard: { entityTokens: ['hana'], attrKeywords: ['instrument'] } },

    // ── wrong-attribute: rich same-entity profile lures retrieval away
    //    from the asked-but-unstored attribute (autopsy Case 4 shape) ──
    { trapClass: 'wrong-attribute', idx: 0, query: 'What car does Amara drive?', guard: { entityTokens: ['amara'], attrKeywords: ['car'] } },
    { trapClass: 'wrong-attribute', idx: 1, query: 'Where does Bruno live?', guard: { entityTokens: ['bruno'], attrKeywords: ['live', 'lives', 'apartment', 'house'] } },
    { trapClass: 'wrong-attribute', idx: 2, query: 'Which sport does Chiara follow?', guard: { entityTokens: ['chiara'], attrKeywords: ['sport'] } },
    { trapClass: 'wrong-attribute', idx: 3, query: 'What does Dario do for work?', guard: { entityTokens: ['dario'], attrKeywords: ['job', 'employer', 'salary'] } },
    { trapClass: 'wrong-attribute', idx: 4, query: 'Which instrument does Elif play?', guard: { entityTokens: ['elif'], attrKeywords: ['instrument'] } },
    { trapClass: 'wrong-attribute', idx: 5, query: 'What is Farids favorite food?', guard: { entityTokens: ['farid'], attrKeywords: ['favorite', 'food'] } },
    { trapClass: 'wrong-attribute', idx: 6, query: 'Which languages does Greta speak?', guard: { entityTokens: ['greta'], attrKeywords: ['languages', 'speaks', 'fluent', 'swedish', 'german'] } },
    { trapClass: 'wrong-attribute', idx: 7, query: 'What car does Hugo drive?', guard: { entityTokens: ['hugo'], attrKeywords: ['car'] } },

    // ── wrong-relationship: relationship X asked where only Y exists ──
    { trapClass: 'wrong-relationship', idx: 0, query: 'Who manages Kenji?', guard: { entityTokens: ['kenji'], attrKeywords: ['manage', 'manages', 'manager'] } },
    { trapClass: 'wrong-relationship', idx: 1, query: 'Who is Priyas business partner?', guard: { entityTokens: ['priya'], attrKeywords: ['partner', 'business'] } },
    { trapClass: 'wrong-relationship', idx: 2, query: 'Who mentors Fatima?', guard: { entityTokens: ['fatima'], attrKeywords: ['mentor', 'mentors'] } },
    { trapClass: 'wrong-relationship', idx: 3, query: 'Which company sponsors Dario?', guard: { entityTokens: ['dario'], attrKeywords: ['sponsor', 'sponsors', 'company'] } },
    { trapClass: 'wrong-relationship', idx: 4, query: 'Who is Amaras roommate?', guard: { entityTokens: ['amara'], attrKeywords: ['roommate'] } },
    { trapClass: 'wrong-relationship', idx: 5, query: 'At which hospital does Bruno work?', guard: { entityTokens: ['bruno'], attrKeywords: ['hospital'] } },
    { trapClass: 'wrong-relationship', idx: 6, query: 'Who lives next door to Greta?', guard: { entityTokens: ['greta'], attrKeywords: ['neighbor'] } },
    { trapClass: 'wrong-relationship', idx: 7, query: 'Which dog belongs to Chiara?', guard: { entityTokens: ['chiara'], attrKeywords: ['dog', 'belongs'] } },

    // ── semantic-near-miss: embedding/lexically close paraphrase traps
    //    around the preference corpus (autopsy Mechanism A shape) ──
    { trapClass: 'semantic-near-miss', idx: 0, query: 'Which podcasts does Amara play on her commute?', guard: { entityTokens: ['amara'], attrKeywords: ['podcast', 'podcasts'] } },
    { trapClass: 'semantic-near-miss', idx: 1, query: 'Which coffee beans does Bruno grind at night?', guard: { entityTokens: ['bruno'], attrKeywords: ['bean', 'beans', 'grind'] } },
    { trapClass: 'semantic-near-miss', idx: 2, query: 'Which novels does Greta save for vacation trips?', guard: { entityTokens: ['greta'], attrKeywords: ['novel', 'novels', 'vacation'] } },
    { trapClass: 'semantic-near-miss', idx: 3, query: 'Which route does Kaya jog on weekends?', guard: { entityTokens: ['kaya'], attrKeywords: ['route'] } },
    { trapClass: 'semantic-near-miss', idx: 4, query: 'Which meditation app does Olive subscribe to?', guard: { entityTokens: ['olive'], attrKeywords: ['app', 'subscribe', 'subscription'] } },
    { trapClass: 'semantic-near-miss', idx: 5, query: 'Which airline does Nils fly most often?', guard: { entityTokens: ['nils'], attrKeywords: ['airline'] } },
    { trapClass: 'semantic-near-miss', idx: 6, query: 'Which restaurant makes Majas favorite salad dressing?', guard: { entityTokens: ['maja'], attrKeywords: ['restaurant', 'dressing'] } },
    { trapClass: 'semantic-near-miss', idx: 7, query: 'Which notebook brand does Leon write in?', guard: { entityTokens: ['leon'], attrKeywords: ['notebook', 'brand'] } },

    // ── temporal-mismatch: point-in-time question predating EVERY version
    //    of an existing chain (no version was valid at the asked time) ──
    { trapClass: 'temporal-mismatch', idx: 0, query: 'What database did the atlas project use in early 2025?', guard: { entityTokens: ['atlas'], attrKeywords: ['database'], askedTimeISO: '2025-06-30T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 1, query: 'What framework did the beacon service use throughout 2024?', guard: { entityTokens: ['beacon'], attrKeywords: ['framework', 'built', 'express', 'fastify', 'hono'], askedTimeISO: '2024-12-31T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 2, query: 'Which package manager did the cedar repo use back in 2023?', guard: { entityTokens: ['cedar'], attrKeywords: ['npm', 'yarn', 'pnpm', 'dependency', 'management'], askedTimeISO: '2023-12-31T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 3, query: 'Where was Grove hosted during 2024?', guard: { entityTokens: ['grove'], attrKeywords: ['hosted'], askedTimeISO: '2024-12-31T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 4, query: 'How did Dune deploy in 2025?', guard: { entityTokens: ['dune'], attrKeywords: ['deploy', 'deploys'], askedTimeISO: '2025-12-31T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 5, query: 'What auth provider did Ember use in 2024?', guard: { entityTokens: ['ember'], attrKeywords: ['auth0', 'clerk', 'ory', 'authentication'], askedTimeISO: '2024-12-31T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 6, query: 'What language was the flint parser written in during 2022?', guard: { entityTokens: ['flint'], attrKeywords: ['parser', 'written'], askedTimeISO: '2022-12-31T23:59:59.999Z' } },
    { trapClass: 'temporal-mismatch', idx: 7, query: 'What object storage did Zephyr use in late 2025?', guard: { entityTokens: ['zephyr'], attrKeywords: ['storage', 'stores', 'files', 's3', 'gcs'], askedTimeISO: '2025-06-30T23:59:59.999Z' } },

    // ── superseded-fact-current-query: current value asked where every
    //    version stating it is superseded and the successor is silent ──
    { trapClass: 'superseded-fact-current-query', idx: 0, query: 'What car does Talia drive?', guard: { entityTokens: ['talia'], attrKeywords: ['car'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 1, query: 'Which web framework does Mateo use?', guard: { entityTokens: ['mateo'], attrKeywords: ['web', 'framework'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 2, query: 'Which yoga style does Renata teach?', guard: { entityTokens: ['renata'], attrKeywords: ['yoga'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 3, query: 'Which lager recipe does Oscar brew?', guard: { entityTokens: ['oscar'], attrKeywords: ['lager', 'recipe'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 4, query: 'Which acrylic technique does Nadia prefer?', guard: { entityTokens: ['nadia'], attrKeywords: ['acrylic', 'acrylics', 'technique'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 5, query: 'How large do Felixs tomatoes grow?', guard: { entityTokens: ['felix'], attrKeywords: ['tomato', 'tomatoes'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 6, query: 'Who tuned Ivetas violin?', guard: { entityTokens: ['iveta'], attrKeywords: ['violin', 'tuned'], requireAllSuperseded: true } },
    { trapClass: 'superseded-fact-current-query', idx: 7, query: 'Where does Bram source his colombian beans?', guard: { entityTokens: ['bram'], attrKeywords: ['colombian'], requireAllSuperseded: true } },

    // ── contradictory-evidence: two designed dual-active rows disagree;
    //    ideal behavior is qualified/abstain, never confident ──
    {
      trapClass: 'contradictory-evidence', idx: 0, query: 'On which day does Yara book client meetings?',
      guard: { entityTokens: ['yara'], attrKeywords: ['meetings', 'tuesdays', 'thursdays'], exemptBenchIds: conflictPairBenchIds('yara') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 1, query: 'Which city office does Zaid report to?',
      guard: { entityTokens: ['zaid'], attrKeywords: ['office', 'lisbon', 'porto'], exemptBenchIds: conflictPairBenchIds('zaid') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 2, query: 'Where does Cleo keep the spare keys?',
      guard: { entityTokens: ['cleo'], attrKeywords: ['keys', 'drawer', 'cabinet'], exemptBenchIds: conflictPairBenchIds('cleo') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 3, query: 'On which floor does Anwar sit?',
      guard: { entityTokens: ['anwar'], attrKeywords: ['floor', 'fourth', 'sixth'], exemptBenchIds: conflictPairBenchIds('anwar') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 4, query: 'When does Lidia run sprint reviews?',
      guard: { entityTokens: ['lidia'], attrKeywords: ['reviews', 'monday', 'wednesday'], exemptBenchIds: conflictPairBenchIds('lidia') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 5, query: 'Who manages the Berlin accounts?',
      guard: { entityTokens: ['berlin', 'accounts'], attrKeywords: ['manages'], exemptBenchIds: conflictPairBenchIds('berlin-accounts') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 6, query: 'Where does Ruslan keep his backups?',
      guard: { entityTokens: ['ruslan'], attrKeywords: ['backups', 'nas', 'cloud'], exemptBenchIds: conflictPairBenchIds('ruslan') },
    },
    {
      trapClass: 'contradictory-evidence', idx: 7, query: 'What time does Sannas team meet?',
      guard: { entityTokens: ['sannas'], attrKeywords: ['meets', 'nine'], exemptBenchIds: conflictPairBenchIds('sanna') },
    },

    // ── absent-entity: zero corpus footprint anywhere, any status ──
    { trapClass: 'absent-entity', idx: 0, query: 'What is Ximenas blood type?', guard: { entityTokens: ['ximena'], attrKeywords: ['blood', 'type'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 1, query: 'Where does Thandiwe keep her passport?', guard: { entityTokens: ['thandiwe'], attrKeywords: ['passport'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 2, query: 'Which languages does Bogdan speak?', guard: { entityTokens: ['bogdan'], attrKeywords: ['language', 'languages'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 3, query: 'Which gym does Esme train at?', guard: { entityTokens: ['esme'], attrKeywords: ['gym'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 4, query: 'What is Ferrans favorite board game?', guard: { entityTokens: ['ferran'], attrKeywords: ['board', 'game'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 5, query: 'When did Aline move to Canada?', guard: { entityTokens: ['aline'], attrKeywords: ['canada'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 6, query: 'What car does Yusuf drive?', guard: { entityTokens: ['yusuf'], attrKeywords: ['car'], requireEntityAbsent: true } },
    { trapClass: 'absent-entity', idx: 7, query: 'Which university did Milena attend?', guard: { entityTokens: ['milena'], attrKeywords: ['university', 'attended'], requireEntityAbsent: true } },

    // ── partial-match: shares surface tokens with an unrelated memory
    //    (the old noise-hijack shape from the autopsy) ──
    { trapClass: 'partial-match', idx: 0, query: 'What brand of coffee pods does the office stock?', guard: { entityTokens: ['coffee', 'pods'], attrKeywords: ['brand', 'stock'] } },
    { trapClass: 'partial-match', idx: 1, query: 'How much does parking lot B cost per hour?', guard: { entityTokens: ['parking'], attrKeywords: ['cost', 'hour'] } },
    { trapClass: 'partial-match', idx: 2, query: 'Who won the newsletter writing contest?', guard: { entityTokens: ['newsletter'], attrKeywords: ['contest'] } },
    { trapClass: 'partial-match', idx: 3, query: 'Which model is the new standing desk?', guard: { entityTokens: ['standing', 'desks', 'desk'], attrKeywords: ['model'] } },
    { trapClass: 'partial-match', idx: 4, query: 'When does the fire extinguisher inspection expire?', guard: { entityTokens: ['extinguisher'], attrKeywords: ['expire', 'expires'] } },
    { trapClass: 'partial-match', idx: 5, query: 'Who teaches the Wednesday yoga class?', guard: { entityTokens: ['yoga', 'wednesday'], attrKeywords: ['teacher', 'taught'] } },
    { trapClass: 'partial-match', idx: 6, query: 'Which toner model fits the floor 2 printer?', guard: { entityTokens: ['printer', 'toner'], attrKeywords: ['model'] } },
    { trapClass: 'partial-match', idx: 7, query: 'Which technician performs the Saturday maintenance window?', guard: { entityTokens: ['maintenance', 'saturday'], attrKeywords: ['technician'] } },

    // ── multi-hop-trap: composing halves exist separately but NO memory
    //    states their join; fusion attempts must fail into abstention ──
    {
      trapClass: 'multi-hop-trap', idx: 0, query: 'In which city was Priyas car bought?',
      guard: { entityTokens: ['priya', 'volvo'], attrKeywords: ['bought', 'purchase', 'purchased'], hopHalfTokens: [['priya', 'volvo'], ['kenji', 'osaka']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 1, query: 'In which city did Kenji buy his phone?',
      guard: { entityTokens: ['kenji'], attrKeywords: ['buy', 'bought', 'phone'], hopHalfTokens: [['kenji', 'osaka'], ['ivan', 'riga']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 2, query: 'Which bank issued Marisols credit card?',
      guard: { entityTokens: ['marisol'], attrKeywords: ['bank', 'credit', 'issued'], hopHalfTokens: [['marisol', 'statistics']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 3, query: 'At which hospital does Gustavs brother work?',
      guard: { entityTokens: ['gustav', 'brother'], attrKeywords: ['hospital'], hopHalfTokens: [['gustav', 'swedish'], ['marys', 'hospital']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 4, query: 'What breed is Hanas sisters dog?',
      guard: { entityTokens: ['hana', 'sister', 'dog'], attrKeywords: ['breed'], hopHalfTokens: [['hana', 'peanuts'], ['retriever']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 5, query: 'Which airline flies Qing to ensemble tours?',
      guard: { entityTokens: ['qing', 'ensemble'], attrKeywords: ['airline', 'flies', 'tours'], hopHalfTokens: [['qing', 'erhu'], ['farid', 'train']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 6, query: 'Who catered Junes graduation party?',
      guard: { entityTokens: ['june'], attrKeywords: ['cater', 'party', 'graduation'], hopHalfTokens: [['june', 'seoul'], ['engineering']] },
    },
    {
      trapClass: 'multi-hop-trap', idx: 7, query: 'Which marina takes Kwames fishing boat?',
      guard: { entityTokens: ['kwame', 'boat'], attrKeywords: ['marina', 'harbor', 'docks'], hopHalfTokens: [['kwame', 'cocoa'], ['ghana']] },
    },
  ];

  return specs.map(({ trapClass, idx, query, guard }) => ({
    benchId: `au_${trapClass}_${idx}_q`,
    category: 'unanswerable' as const,
    trapClass,
    query,
    integrityGuard: guard,
  }));
}

// â”€â”€â”€ 5. Edge cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Edge case fixtures for robustness testing.
 *
 * 5a. Empty query: query is an empty string. Should return results or empty,
 *     never crash.
 * 5b. Long query: 500+ word query. Should complete within timeout.
 * 5c. Special characters: query with @#$%^&*() and other punctuation.
 * 5d. Noise: 10 random low-relevance memories mixed with 1 relevant one.
 * 5e. Partial match: query partially matches a memory but not exactly.
 */

export function buildEdgeCaseMemories(): BenchMemory[] {
  const memories: BenchMemory[] = [];

  // Noise memories (5d): 10 low-relevance entries
  const noiseContents = [
    { content: 'The office kitchen was restocked with new coffee pods on Tuesday.', tags: ['kitchen', 'office'] },
    { content: 'Parking lot B will be closed for resurfacing next Monday.', tags: ['parking', 'office'] },
    { content: 'The quarterly newsletter deadline is the 15th of each month.', tags: ['newsletter', 'deadline'] },
    { content: 'New standing desks arrived in the west wing conference room.', tags: ['desk', 'office'] },
    { content: 'The fire extinguisher on floor 3 was inspected and certified.', tags: ['safety', 'floor3'] },
    { content: 'Free yoga sessions start at 7 AM every Wednesday in the gym.', tags: ['yoga', 'wellness'] },
    { content: 'The printer on floor 2 is out of toner and awaiting refill.', tags: ['printer', 'floor2'] },
    { content: 'Employee parking permits must be renewed by end of January.', tags: ['parking', 'permit'] },
    { content: 'The break room microwave was replaced with a new model.', tags: ['kitchen', 'microwave'] },
    { content: 'IT will perform network maintenance this Saturday from 2-6 AM.', tags: ['it', 'maintenance'] },
  ];

  noiseContents.forEach((n, idx) => {
    memories.push({ benchId: `noise_${idx}`, type: 'observation', tags: n.tags, content: n.content, createdAt: isoDay(5, idx) });
  });

  // The single relevant memory that must be found despite noise (5d).
  // Wording + timestamp notes: this row states the LATEST atlas state
  // (PostgreSQL 16 + pgvector, after the failed MySQL experiment), so it is
  // dated AFTER the fu_0 chain. Deliberate phrasing constraints:
  //   - "uses ... as its primary database" mirrors the query frame so the
  //     fused semantic score outranks the atlas chain under the final=1.0
  //     clamp (ties inside the clamp resolve on pre-boost fused score).
  //   - NO update-indicator words ("now", "instead of", ...) and < 0.85
  //     subject similarity to the fu_0 rows, so seeding never supersedes
  //     the atlas chain through it (that would break fu_0_q_current).
  memories.push({
    benchId: 'noise_relevant',
    type: 'fact',
    tags: ['database', 'atlas'],
    content: 'The atlas project uses PostgreSQL 16 with pgvector as its primary database.',
    createdAt: isoDay(120, 10),
  });

  // Partial match memory (5e)
  memories.push({
    benchId: 'partial_0',
    type: 'fact',
    tags: ['api', 'gateway'],
    content: 'The API gateway uses rate limiting with a default of 100 requests per minute per client.',
    createdAt: isoDay(10, 0),
  });

  return memories;
}

/** Long query: ~520 words describing a complex scenario. */
const LONG_QUERY = Array.from({ length: 52 }, (_, i) =>
  `word${i} describing aspect ${i} of the system architecture including deployment strategy database choice caching layer message queue frontend framework build tool test runner linter formatter type checker package manager CI CD pipeline monitoring logging alerting tracing instrumentation metrics dashboard`
).join(' ');

export function buildEdgeCaseQueries(): BenchQuery[] {
  return [
    // 5a: empty query
    { benchId: 'edge_empty_q', category: 'edge-empty', query: '' },

    // 5b: long query (~520 words)
    { benchId: 'edge_long_q', category: 'edge-long', query: LONG_QUERY },

    // 5c: special characters
    { benchId: 'edge_special_q', category: 'edge-special-chars', query: 'What is @the $status of #database? (version 2.0) - [pending] {resolved} | active & ready! *confirmed* _underlined_ <checked> = done?' },

    // 5d: noise - must still find the relevant memory among 10 noise entries
    { benchId: 'edge_noise_q', category: 'edge-noise', query: 'What database does the atlas project use?', expectTop1: ['noise_relevant'] },

    // 5e: partial match - query partially matches but not exactly
    { benchId: 'edge_partial_q', category: 'edge-partial-match', query: 'What rate limiting configuration does the API use?', expectTop1: ['partial_0'] },
  ];
}

// â”€â”€â”€ Assembled corpus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BenchCorpus {
  memories: BenchMemory[];
  queries: BenchQuery[];
}

export function buildBenchCorpus(): BenchCorpus {
  return {
    memories: [
      // Adversarial rows seed FIRST: the contradiction resolver only scans
      // the first 100 active rows (rowid order) when matching supersessions,
      // so early placement keeps the am_sup_* v1->v2 chains inside the scan
      // window and isolates main-corpus writes from them. See
      // buildAdversarialMemories and bench-integrity.test.ts.
      ...buildAdversarialMemories(),
      ...buildFactUpdateMemories(),
      ...buildFalsehoodMemories(),
      ...buildPreferenceMemories(),
      ...buildEdgeCaseMemories(),
    ],
    queries: [
      ...buildFactUpdateQueries(),
      ...buildFalsehoodQueries(),
      ...buildPreferenceQueries(),
      ...buildUnanswerableQueries(),
      ...buildAdversarialUnanswerables(),
      ...buildEdgeCaseQueries(),
    ],
  };
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Deterministic ISO timestamp: dayOffset days after 2026-01-01, plus idx hours for stable intra-day ordering. */
export function isoDay(dayOffset: number, idx: number): string {
  return new Date(Date.UTC(2026, 0, 1 + dayOffset, idx % 24)).toISOString();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

