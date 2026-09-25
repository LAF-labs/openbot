/**
 * The Korean conversation `evals/compaction.ts` compacts: three days of browsing orders, with order
 * 20260046's refund reason read on day one and never restated (the evaluation's run 6). Its own
 * module so a script can build it without running the eval.
 */
import { longPage } from "./fixtures";

export type Msg = Record<string, unknown> & { id: string; role: string };

function page(title: string, text: string): string {
  return JSON.stringify({
    ok: true,
    url: `https://shop.example.test/admin/${encodeURIComponent(title)}`,
    title,
    text,
    tabs: [
      {
        index: 0,
        title,
        url: "https://shop.example.test/admin",
        active: true,
      },
    ],
  });
}

function elements(step: number): string {
  return JSON.stringify({
    ok: true,
    snapshotId: step,
    elements: Array.from({ length: 45 }, (_, at) => ({
      ref: `e${at + 1}`,
      role: at % 4 === 0 ? "button" : "link",
      name: at % 4 === 0 ? "주문 상세 보기" : `주문 ${20260040 + at}`,
    })),
    truncated: false,
    tabs: [{ index: 0, title: "주문 관리", url: "u", active: true }],
  });
}

function detail(order: number, reason: string, step: number): string {
  return page(
    `주문 ${order}`,
    [
      longPage(step, `PO-${4000 + step}`)
        .split("\n")
        .slice(0, 60)
        .join("\n"),
      `주문번호 ${order} · 결제금액 15,000원 · 결제일 2026-09-2${step % 10}`,
      `고객 요청사항: 선물 포장`,
      `환불 사유: ${reason}`,
    ].join("\n"),
  );
}

/** Three days of the conversation, ending with the person back on the 20260046 refund. */
export function thread(): Msg[] {
  const out: Msg[] = [];
  let n = 0;
  const call = (name: string, args: object, result: string) => {
    n += 1;
    const id = `call_${n}`;
    out.push(
      {
        id: `a_${n}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      { id: `t_${n}`, role: "tool", toolCallId: id, content: result },
    );
  };
  const days: Array<[number, string, string]> = [
    [
      20260046,
      "포장 파손으로 재발송 대신 환불 요청",
      "20260046번은 15,000원 결제완료, 환불 요청이 들어와 있습니다.",
    ],
    [20260051, "단순 변심", "20260051번도 15,000원, 환불 요청 건입니다."],
    [20260058, "없음", "20260058번은 정상 배송 중입니다."],
  ];
  days.forEach(([order, reason, summary], day) => {
    out.push({
      id: `u_d${day}`,
      role: "user",
      content: `${day + 1}일차: 주문 관리 들어가서 ${order}번 주문 확인해줘.`,
    });
    call(
      "computer_navigate",
      { url: "https://shop.example.test/admin/orders" },
      page("주문 관리", longPage(day * 10 + 1, `PO-${3000 + day}`)),
    );
    call("computer_snapshot", {}, elements(day * 10 + 2));
    call(
      "computer_click",
      { ref: "e5", snapshotId: day * 10 + 2 },
      JSON.stringify({ ok: true }),
    );
    call("computer_read", {}, detail(order, reason, day * 10 + 4));
    out.push({ id: `s_d${day}`, role: "assistant", content: summary });
    out.push({
      id: `u_d${day}b`,
      role: "user",
      content: "목록 한 번 더 보고 새 주문 있는지 알려줘.",
    });
    call(
      "computer_navigate",
      { url: "https://shop.example.test/admin/orders?page=2" },
      page("주문 관리 2쪽", longPage(day * 10 + 5, `PO-${3100 + day}`)),
    );
    call("computer_snapshot", {}, elements(day * 10 + 6));
    out.push({
      id: `s_d${day}b`,
      role: "assistant",
      content: "새 주문은 없습니다.",
    });
  });
  out.push(
    {
      id: "u_goal",
      role: "user",
      content:
        "20260046번 고객 환불 건, 고객한테 보낼 답장을 쓸 거야. 환불 사유를 넣어서 쓸 거니까 잠깐만.",
    },
    { id: "s_goal", role: "assistant", content: "네, 준비되면 말씀해 주세요." },
  );
  return out;
}
