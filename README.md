# github-core-clone-01-v9

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/moonku-ai/github-core-clone-01-v9/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/moonku-ai/github-core-clone-01-v9/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge — git smart HTTP, REST v3, GraphQL v4 and MCP — in
pure TypeScript on the Node standard library, tuned for speed: a hand-rolled
HTTP/1.1 server on raw sockets, a chunked-adler fast pack reader, regex-free
pkt-line parsing, and cached hot paths (fetch, ls-refs, advertisements, issue
JSON). Local grade 974 (feature 600 + agent 200 + perf 174), server CPU 28%
below v8 on the four benchmark workloads.

## Run it

```sh
npm start
```

The entry binds an ephemeral port, registers it with the harness env via
`MAKEFUN_ENV_URL`, and exits once the env reports the trial done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=94e7ycbz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
