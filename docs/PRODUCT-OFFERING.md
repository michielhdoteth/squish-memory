# Squish product, license, and availability

**Verified:** 2026-11-01. This snapshot separates shipped/public state from local source configuration. Recheck before a release.

## Squish Core

Squish Core is first-party open-source software under the MIT License. It can be used, modified, distributed, and integrated into personal or commercial applications, including proprietary software, subject to the MIT terms and notices. No Squish subscription is required for local use. Local memories are stored in SQLite; available device storage is the practical capacity limit. CLI and MCP are the main developer interfaces. Local models and BYOK are supported for selected operations; provider fees and network behavior depend on the configured provider.

The desktop shell is also MIT licensed. This does not relicense the hosted API source or third-party libraries, models, and assets; those retain their own rights and notices.

## Squish Cloud and managed AI

The live website lists Pro at $79/year and Founding Lifetime at $199 once for hosted memory API and MCP access, while displaying checkout as unavailable. Those amounts match the current API source constants and source tests, but the deployed API plan catalog does not return price fields. The source API plan configuration sets each paid plan to hosted MCP, cloud sync, a 100,000 hosted-memory limit, no customer backup entitlement, and a zero managed-AI allowance.

The deployed plan endpoint currently returns plan names, request and memory limits, and `hosted_mcp`, but omits price fields and `cloud_sync`. Therefore the live endpoint does not confirm the source checkout's pricing or sync configuration. The website copy does not promise cross-device sync, customer backups, or managed inference. Local inference and BYOK are distinct from managed AI and can incur provider charges.

**Release rule:** do not advertise checkout, sync, backup, or managed-AI entitlements as active until the deployed plan catalog, checkout, and account entitlements agree. Do not change prices or billing behavior as part of copy updates.

## Benchmark claims

The public website does not currently publish a comparable end-to-end answer-quality or agent-task score. The committed golden fixture has 46 queries and a historical retrieval report, but this is a narrow retrieval diagnostic, not an answer-quality evaluation. See [`BENCHMARK.md`](BENCHMARK.md) for its configuration, limitations, and reproduction guidance. The older v2.1.0 report's ECE 0.055 is historical and must not be presented as a current score.

## Sources of truth

| Subject | Canonical source |
|---|---|
| Core and desktop software license | Each repository's `LICENSE` and package `license` field |
| Current cloud price and source entitlements | `../../squish-cloud/squish-api/lib/stripe.js`, price validators, `/api/plans`, and plan-catalog tests |
| Checkout availability | `squish-landing/config/hostedAvailability.ts` and deployed checkout flow |
| Public feature status and pricing copy | `squish-landing/components/Pricing.tsx`, `PricingPage.tsx`, and `config/seo-routes.json` |
| Benchmark scope and evidence | `docs/BENCHMARK.md`, committed fixture reports, and the public `/benchmarks` page |
| Published runtime package | npm registry metadata and the matching tagged GitHub release; source ahead of release is not a published offer |
