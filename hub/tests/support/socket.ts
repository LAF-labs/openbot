/** A test's end of a hub socket: frames as they arrive, and a way to wait for the next ones. */
export type Frame = {
  kind: string;
  seq?: number;
  type?: string;
  refId?: string | null;
};

export type TestSocket = {
  frames: Frame[];
  /** Resolves with the first `count` event frames after `from`, or rejects after `ms`. */
  events(count: number, ms?: number): Promise<Frame[]>;
  closed: Promise<{ code: number; reason: string }>;
  send(data: string): void;
  close(): void;
};

export function openSocket(
  url: string,
  pass: string,
  query = "",
  options: { answerPings?: boolean } = {},
): Promise<TestSocket> {
  const socket = new WebSocket(
    `${url.replace(/^http/, "ws")}/hub/v1/events${query}`,
    {
      headers: { authorization: `Bearer ${pass}` },
    } as unknown as string[],
  );
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as Frame;
    frames.push(frame);
    // A VM answers the hub's pings; a test that is about something else does too.
    if (options.answerPings && frame.kind === "ping") {
      socket.send(JSON.stringify({ kind: "pong" }));
    }
    for (const wake of waiters) wake();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    );
  });
  const eventFrames = () => frames.filter((frame) => frame.kind === "event");
  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error("socket refused")));
    socket.addEventListener("open", () =>
      resolve({
        frames,
        closed,
        send: (data) => socket.send(data),
        close: () => socket.close(),
        events(count, ms = 2_000) {
          return new Promise((done, fail) => {
            const check = () => {
              if (eventFrames().length >= count) {
                waiters.delete(check);
                clearTimeout(timer);
                done(eventFrames().slice(0, count));
              }
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(
                new Error(
                  `waited ${ms} ms for ${count} events, had ${eventFrames().length}`,
                ),
              );
            }, ms);
            waiters.add(check);
            check();
          });
        },
      }),
    );
  });
}
