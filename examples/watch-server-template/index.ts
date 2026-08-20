/**
 * LAF MCP 계약의 실행 가능한 최소 서버 — 여기서 시작하라.
 *
 * 채울 곳은 collectSignals() 하나다. 계약(docs/laf/mcp-contract.md)의 세 규칙:
 * 읽기 쿼리는 인덱스를 탈 것, status 판정은 여기서 끝낼 것, 백엔드가 죽어도
 * 프로토콜 에러 대신 신호로 답할 것.
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number.parseInt(process.env.PORT ?? "8765", 10);

type Signal = {
  key: string;
  status: "ok" | "warn" | "fail";
  value?: number | string;
  since?: string;
  detail?: string;
};

async function collectSignals(): Promise<Signal[]> {
  try {
    // TODO: 자사 시스템에서 "멈추면 큰일"인 것들을 읽어 채운다.
    // 예: 승인 대기 큐 길이, 배치 마지막 성공 시각, 재고 임계.
    // 문턱 판정(몇 개부터 warn인가)은 반드시 여기서 끝낸다.
    return [
      { key: "queue.example", status: "ok", value: 0 },
      { key: "db.reachable", status: "ok" },
    ];
  } catch (error) {
    // 백엔드 장애는 신호다 — 프로토콜 에러가 아니다 (계약 §1.2).
    const detail = error instanceof Error ? error.message : String(error);
    return [
      { key: "db.reachable", status: "fail", detail: detail.slice(0, 300) },
    ];
  }
}

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "watch-server-template",
    version: "0.1.0",
  });
  server.registerTool(
    "laf.watch",
    {
      description: "운영 신호를 {signals:[...]} 배열로 반환한다.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ signals: await collectSignals() }),
        },
      ],
    }),
  );
  // TODO: 자유 툴을 여기 추가한다 — 툴마다 어노테이션 필수 (계약 §2).
  return server;
}

// 무상태 Streamable HTTP: 요청마다 만들고 버린다. 재시작이 아무것도 잃지 않는다.
const httpServer = createServer(async (req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => void transport.close());
  const server = buildMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, () => {
  console.log(`watch-server-template on http://127.0.0.1:${PORT}/mcp`);
});
