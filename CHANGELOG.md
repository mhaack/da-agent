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
