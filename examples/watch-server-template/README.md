# watch-server-template

LAF MCP 계약([docs/laf/mcp-contract.md](../../docs/laf/mcp-contract.md))의
실행 가능한 최소 서버. `collectSignals()` 하나만 채우면 `laf.watch`가
완성된다. 자유 툴은 어노테이션과 함께 추가한다.

```bash
bun install
bun start                       # http://127.0.0.1:8765/mcp
bun ../../server/scripts/laf-mcp-check.ts http://127.0.0.1:8765/mcp   # 제출 전 검사
```

순서와 주의는 [연결 가이드](../../docs/laf/onboarding-guide.md).
