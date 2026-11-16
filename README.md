# github-core-clone-01: GitHub-Compatible Git Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/VincenzoT1/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/VincenzoT1/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## Overview
A standalone, high-performance GitHub-compatible Git forge built in pure Node.js 22 with standard libraries only.

### Implemented Capabilities
- **REST API v3**: `/api/v3` endpoints for repository management, contents, branches, commits, labels, issues, issue comments, and pull requests with merge support.
- **Model Context Protocol (MCP)**: Streamable JSON-RPC endpoint at `/mcp` implementing `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request`.
- **GraphQL v4**: `/api/graphql` supporting query introspection, `viewer`, `repository`, issues, pull requests, and mutations.
- **Git Smart-HTTP**: Protocol v2 `upload-pack` and v0 `receive-pack` supporting packet-line framing, ref advertisement, shallow fetch, and push.

## License
[MIT](LICENSE)

