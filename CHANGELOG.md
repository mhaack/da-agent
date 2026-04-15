# [1.13.0](https://github.com/adobe-rnd/da-agent/compare/v1.12.0...v1.13.0) (2026-04-09)


### Features

* support setting headers for mcp ([f5284d7](https://github.com/adobe-rnd/da-agent/commit/f5284d709dca22932be18c4c5e21f060159887a9))

# [1.12.0](https://github.com/adobe-rnd/da-agent/compare/v1.11.0...v1.12.0) (2026-04-08)


### Features

* Connect to the governance agent ([#16](https://github.com/adobe-rnd/da-agent/issues/16)) ([c4882e5](https://github.com/adobe-rnd/da-agent/commit/c4882e564d78edbd6683457406143ecaae651a12))

# [1.11.0](https://github.com/adobe-rnd/da-agent/compare/v1.10.1...v1.11.0) (2026-03-31)


### Bug Fixes

* deduplicate memory headings, gate instructions on adminClient, move blocks adjacent ([1915bbf](https://github.com/adobe-rnd/da-agent/commit/1915bbf4b35198216ff8a30526b79763c09521ce))
* handle pre-parsed JSON array from DA client in updateRecentPages ([f2464c9](https://github.com/adobe-rnd/da-agent/commit/f2464c9574885f8df24c1d4aa281566f1224913a))
* separate network and JSON parse errors in updateRecentPages ([fecf0eb](https://github.com/adobe-rnd/da-agent/commit/fecf0eb9c76445c0e1835f6ae17b96319cac703b))
* update ([113f418](https://github.com/adobe-rnd/da-agent/commit/113f4180554e62e549934c1504b4f8fd3e0a319d))
* use context org/site in update_recent_pages and tighten description ([aad876e](https://github.com/adobe-rnd/da-agent/commit/aad876ef9a69c68714722ee08eb72a079c4a4ec8))
* validate non-empty memory content and document no-approval intent ([4d81357](https://github.com/adobe-rnd/da-agent/commit/4d813575a22d8da557967ad16d06585b0ee60bbf))


### Features

* add memory loader for project memory and recent pages ([ddbc120](https://github.com/adobe-rnd/da-agent/commit/ddbc1207be50213e3aeaa1a762a876774f654610))
* add write_project_memory and update_recent_pages tools ([a41bea7](https://github.com/adobe-rnd/da-agent/commit/a41bea7c8bb93f00a52cb8dc60c6643c679fe5ba))
* implement memory ([097ae69](https://github.com/adobe-rnd/da-agent/commit/097ae6923cd2b7d720d8fad1a114b98aa714e8e5))
* inject project memory into system prompt and replace session memory footer ([447bf58](https://github.com/adobe-rnd/da-agent/commit/447bf587b4ca8c0f934d3abf385ba96737784160))

## [1.10.1](https://github.com/adobe-rnd/da-agent/compare/v1.10.0...v1.10.1) (2026-03-26)


### Bug Fixes

* **mcp:** adapt MCP tools with Zod schemas for Bedrock / AI SDK v6 ([#14](https://github.com/adobe-rnd/da-agent/issues/14)) ([8c9051d](https://github.com/adobe-rnd/da-agent/commit/8c9051d56dc40aafe882e22a9b5342253dea1559))

# [1.10.0](https://github.com/adobe-rnd/da-agent/compare/v1.9.0...v1.10.0) (2026-03-26)


### Features

* make publish workflow return full url ([d6f3ca7](https://github.com/adobe-rnd/da-agent/commit/d6f3ca742602662b3893405d3782c40d93e63c06))

# [1.9.0](https://github.com/adobe-rnd/da-agent/compare/v1.8.1...v1.9.0) (2026-03-26)


### Features

* skills Lab -- MCP client, agent presets, skills loader, and skill suggestions ([#4](https://github.com/adobe-rnd/da-agent/issues/4)) ([a2ae192](https://github.com/adobe-rnd/da-agent/commit/a2ae1921657e08c5ab133d56b8c4695e2e0f5087))

## [1.8.1](https://github.com/adobe-rnd/da-agent/compare/v1.8.0...v1.8.1) (2026-03-26)


### Bug Fixes

* instruct system prompt to use correct image urls ([25057f7](https://github.com/adobe-rnd/da-agent/commit/25057f75fdd375d5ac6c6e1bdcd40f36fe768928))

# [1.8.0](https://github.com/adobe-rnd/da-agent/compare/v1.7.0...v1.8.0) (2026-03-26)


### Features

* track IMS user ID in Langfuse telemetry ([27e84fa](https://github.com/adobe-rnd/da-agent/commit/27e84fa7283604eddb0f0c7ec8e05d7e96e8aefa))

# [1.7.0](https://github.com/adobe-rnd/da-agent/compare/v1.6.0...v1.7.0) (2026-03-26)


### Bug Fixes

* vibe workflow ([8badacc](https://github.com/adobe-rnd/da-agent/commit/8badaccd1a35f970356561946af9caa13a120348))


### Features

* image upload ([ee3b1bd](https://github.com/adobe-rnd/da-agent/commit/ee3b1bd4383bee549cc85ae5bc182873ac76c689))

# [1.6.0](https://github.com/adobe-rnd/da-agent/compare/v1.5.0...v1.6.0) (2026-03-25)


### Features

* support revert ([edf5b95](https://github.com/adobe-rnd/da-agent/commit/edf5b95e24aa51ed189deae529ce89909eecd2db))

# [1.5.0](https://github.com/adobe-rnd/da-agent/compare/v1.4.2...v1.5.0) (2026-03-25)


### Features

* add human message to edit tool ([cac7abb](https://github.com/adobe-rnd/da-agent/commit/cac7abb864f0cd9d72a29f128332bf267e280839))

## [1.4.2](https://github.com/adobe-rnd/da-agent/compare/v1.4.1...v1.4.2) (2026-03-25)


### Bug Fixes

* use correct external URLs ([52aa81c](https://github.com/adobe-rnd/da-agent/commit/52aa81cd4746e6d3442cffab3c0741710526b164))

## [1.4.1](https://github.com/adobe-rnd/da-agent/compare/v1.4.0...v1.4.1) (2026-03-25)


### Bug Fixes

* update default Langfuse URL in telemetry test ([50069d0](https://github.com/adobe-rnd/da-agent/commit/50069d0c3aeb34a3769accecccad515ccfce264f))
* use Langfuse secrets instead of vars, set Adobe Langfuse URL ([f283e77](https://github.com/adobe-rnd/da-agent/commit/f283e77a6b70b7cf6dc0746d4dbcb7d8c72286a8))

# [1.4.0](https://github.com/adobe-rnd/da-agent/compare/v1.3.0...v1.4.0) (2026-03-25)


### Bug Fixes

* revert Langfuse placeholder to empty string ([3175df3](https://github.com/adobe-rnd/da-agent/commit/3175df342b98f2c4054caf986b8bbead497fcd3e))


### Features

* add Langfuse telemetry module with lazy OTEL init ([358653f](https://github.com/adobe-rnd/da-agent/commit/358653f178580fd554bfbdf04e335240418cac60))
* add path to telemetry metadata ([2aa1f37](https://github.com/adobe-rnd/da-agent/commit/2aa1f3759622daf02fa979ae2cebe3ca5f550b21))
* wire Langfuse telemetry into streamText ([a24ad2a](https://github.com/adobe-rnd/da-agent/commit/a24ad2ab30767244612db835f2d8174f54d4cf64))

# [1.3.0](https://github.com/adobe-rnd/da-agent/compare/v1.2.2...v1.3.0) (2026-03-25)


### Features

* add client-side only tools ([9bc5be7](https://github.com/adobe-rnd/da-agent/commit/9bc5be718914e7e8cc44b4647d6286078db7099d))

## [1.2.2](https://github.com/adobe-rnd/da-agent/compare/v1.2.1...v1.2.2) (2026-03-25)


### Bug Fixes

* auth and unpublish ([b6ca41c](https://github.com/adobe-rnd/da-agent/commit/b6ca41c0ea96d76e1309922abb740db124619aad))
* clean up ([daf4abd](https://github.com/adobe-rnd/da-agent/commit/daf4abd2db848b7657313c422656eec70de2b97f))
* cleanup tool naming ([727869a](https://github.com/adobe-rnd/da-agent/commit/727869aa71a394395b974b9dd40248662e8d1cb2))

## [1.2.1](https://github.com/adobe-rnd/da-agent/compare/v1.2.0...v1.2.1) (2026-03-25)


### Bug Fixes

* auth fix for preview ([645cb03](https://github.com/adobe-rnd/da-agent/commit/645cb03f0d8bce439cd9511ca04e6fb00eec019f))

# [1.2.0](https://github.com/adobe-rnd/da-agent/compare/v1.1.0...v1.2.0) (2026-03-25)


### Bug Fixes

* surface inner status from EDS API response, improve error test coverage ([9e2c253](https://github.com/adobe-rnd/da-agent/commit/9e2c253e4726f0069c7ef19c66191545d0b31ec5))
* use null consistently for absent clients in server and tools options ([a1539a7](https://github.com/adobe-rnd/da-agent/commit/a1539a7114dfac2c4f3ec9c6bffe0b7962499f7a))


### Features

* add EDS admin API types ([2ea4843](https://github.com/adobe-rnd/da-agent/commit/2ea4843c7c6b6b941193a1c519d2c51b1efba88d))
* add eds_preview and eds_publish tools ([0ec4a1a](https://github.com/adobe-rnd/da-agent/commit/0ec4a1adb789cde24e699d6f104944bc6523b167))
* add EDSAdminClient for preview and live publish ([29cb543](https://github.com/adobe-rnd/da-agent/commit/29cb5439d3c383eb0e87f60f98abaa7dc916877e))
* add preview and publish support ([e4aa296](https://github.com/adobe-rnd/da-agent/commit/e4aa2960771f72f9b1e44cbd1a28829d47bb0d20))
* wire up EDSAdminClient in server for preview/publish tools ([be5797b](https://github.com/adobe-rnd/da-agent/commit/be5797b72f2e67cd7137c991e06e0fc0562f5116))

# [1.1.0](https://github.com/adobe-rnd/da-agent/compare/v1.0.2...v1.1.0) (2026-03-25)


### Features

* release ([a1e83ea](https://github.com/adobe-rnd/da-agent/commit/a1e83ea968f46681dbc45b27bbe83cc37da96661))

## [1.0.2](https://github.com/adobe-rnd/da-agent/compare/v1.0.1...v1.0.2) (2026-03-24)


### Reverts

* Revert "fix: decode IMS token to get real user name for collab presence" ([bf1ab19](https://github.com/adobe-rnd/da-agent/commit/bf1ab19c22d48aab4ddb84958b23bb83b84aa01e))

## [1.0.1](https://github.com/adobe-rnd/da-agent/compare/v1.0.0...v1.0.1) (2026-03-24)


### Bug Fixes

* decode IMS token to get real user name for collab presence ([f383474](https://github.com/adobe-rnd/da-agent/commit/f383474d9d3ca3bc6f9b07ca4d1a4b168eeb4269))

# 1.0.0 (2026-03-24)


### Bug Fixes

* call ws.accept() before using service binding WebSocket ([cc19c1b](https://github.com/adobe-rnd/da-agent/commit/cc19c1bdc15701545c67f1ceb75b7c9176f13e41))
* move to bedrock ([5745b9c](https://github.com/adobe-rnd/da-agent/commit/5745b9c8403df2764110ee7d6fa9f1b361a0b18e))
* rework ([8e3235f](https://github.com/adobe-rnd/da-agent/commit/8e3235f712483fde98f1e7277f19e49ad45af284))
* tighten system prompt to prevent HTML in chat responses ([fdb4560](https://github.com/adobe-rnd/da-agent/commit/fdb4560800d917e80d74e7c73e179341f3d94021))


### Features

* add HEAD /chat endpoint ([2f30f5b](https://github.com/adobe-rnd/da-agent/commit/2f30f5b75e7d960b5a9230e1d626381058ab20e4))
* add skills support loaded from .da/skills/ folder ([8c4f7d0](https://github.com/adobe-rnd/da-agent/commit/8c4f7d0bc367da8ca28b97d15d8cd9f64b4c7684))
* add support for version and approval step ([ec7220f](https://github.com/adobe-rnd/da-agent/commit/ec7220fe6ac336afd5432838ad145a1320f9ece7))
* implement stateless tool approval flow for human-in-the-loop ([1adcb70](https://github.com/adobe-rnd/da-agent/commit/1adcb70140d2d0471f7af6386607c405b391a810))

# 1.0.0 (2026-03-24)


### Bug Fixes

* call ws.accept() before using service binding WebSocket ([cc19c1b](https://github.com/adobe-rnd/da-agent/commit/cc19c1bdc15701545c67f1ceb75b7c9176f13e41))
* move to bedrock ([5745b9c](https://github.com/adobe-rnd/da-agent/commit/5745b9c8403df2764110ee7d6fa9f1b361a0b18e))
* rework ([8e3235f](https://github.com/adobe-rnd/da-agent/commit/8e3235f712483fde98f1e7277f19e49ad45af284))
* tighten system prompt to prevent HTML in chat responses ([fdb4560](https://github.com/adobe-rnd/da-agent/commit/fdb4560800d917e80d74e7c73e179341f3d94021))


### Features

* add HEAD /chat endpoint ([2f30f5b](https://github.com/adobe-rnd/da-agent/commit/2f30f5b75e7d960b5a9230e1d626381058ab20e4))
* add skills support loaded from .da/skills/ folder ([8c4f7d0](https://github.com/adobe-rnd/da-agent/commit/8c4f7d0bc367da8ca28b97d15d8cd9f64b4c7684))
* add support for version and approval step ([ec7220f](https://github.com/adobe-rnd/da-agent/commit/ec7220fe6ac336afd5432838ad145a1320f9ece7))
* implement stateless tool approval flow for human-in-the-loop ([1adcb70](https://github.com/adobe-rnd/da-agent/commit/1adcb70140d2d0471f7af6386607c405b391a810))
