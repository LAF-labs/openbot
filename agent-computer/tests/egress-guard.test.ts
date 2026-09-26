import { describe, expect, test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import {
  createEgressGuard,
  defaultGateway,
  destUnreachablesIn,
  EgressUnguardedError,
  outcomeOfError,
  type ProbeResult,
  type ProbeTarget,
  probeTarget,
  targetsFor,
  verdictOf,
} from "../src/egress-guard";

/**
 * THE COMPUTER ASKS THE NETWORK WHETHER THE HOST IS HOLDING ITS EGRESS RULES (security package
 * item 6), and refuses to browse until it is — so a VM whose host rules never arrived fails closed
 * rather than quietly reaching 169.254.169.254 again. Driven here with probe answers; the answers
 * themselves are measured on a real host in the lima drill (docs/laf/deploying.md).
 */

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const blocked = (targets: ProbeTarget[]): Promise<ProbeResult[]> =>
  Promise.resolve(
    targets.map((target) => ({
      target: `${target.host}:${target.port}`,
      outcome: "blocked" as const,
      ms: 1,
    })),
  );
const open = (targets: ProbeTarget[]): Promise<ProbeResult[]> =>
  Promise.resolve(
    targets.map((target, index) => ({
      target: `${target.host}:${target.port}`,
      // The metadata endpoint answering is the leak; the rest times out, as on a laptop.
      outcome: index === 0 ? ("connected" as const) : ("timeout" as const),
      ms: 1,
    })),
  );

describe("what counts as the host refusing", () => {
  test("only the rule's own answer, quickly; a closed port or a timeout is not a firewall", () => {
    expect(outcomeOfError("EHOSTUNREACH", 2)).toBe("blocked");
    // EHOSTUNREACH after seconds is ARP giving up on an address, not a rule.
    expect(outcomeOfError("EHOSTUNREACH", 3_000)).toBe("failed");
    expect(outcomeOfError("ECONNREFUSED", 1)).toBe("refused");
    expect(outcomeOfError("ETIMEDOUT", 1)).toBe("failed");
  });

  test("Bun's ECONNREFUSED is the rule's only when an ICMP destination-unreachable came with it", () => {
    // Measured on the lima drill: Bun names the rule's refusal ECONNREFUSED, like a closed port.
    expect(outcomeOfError("ECONNREFUSED", 0, true)).toBe("blocked");
    expect(outcomeOfError("ECONNREFUSED", 1, false)).toBe("refused");
    expect(outcomeOfError("ECONNREFUSED", 3_000, true)).toBe("refused");
    // An EHOSTUNREACH the kernel did not count as an ICMP answer is some other wall.
    expect(outcomeOfError("EHOSTUNREACH", 2, false)).toBe("failed");
    // Where the count cannot be read, only the faithful errno counts; a refusal stays a closed port.
    expect(outcomeOfError("EHOSTUNREACH", 2, null)).toBe("blocked");
    expect(outcomeOfError("ECONNREFUSED", 1, null)).toBe("refused");
  });

  test("the count is read the way the kernel writes /proc/net/snmp", () => {
    // From the computer container on the lima drill, after nineteen refused probes.
    const snmp = [
      "Ip: Forwarding DefaultTTL InReceives InHdrErrors",
      "Ip: 1 64 301 0",
      "Icmp: InMsgs InErrors InCsumErrors InDestUnreachs InTimeExcds OutMsgs",
      "Icmp: 19 0 0 19 0 0",
      "IcmpMsg: InType3",
      "IcmpMsg: 19",
    ].join("\n");
    expect(destUnreachablesIn(snmp)).toBe(19);
    expect(destUnreachablesIn("Ip: Forwarding\nIp: 1\n")).toBeNull();
    expect(destUnreachablesIn("")).toBeNull();
  });

  test("an attempt reads the count before and after itself", async () => {
    // A port nothing listens on: refused at once, whatever the count says.
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const target = { host: "127.0.0.1", port };

    let count = 7;
    const rising = () => count++;
    expect((await probeTarget(target, 1_500, rising)).outcome).toBe("blocked");
    expect((await probeTarget(target, 1_500, () => 7)).outcome).toBe("refused");
    expect((await probeTarget(target, 1_500, () => null)).outcome).toBe(
      "refused",
    );
  });

  test("guarded only when every target was refused by the rule", () => {
    const at = (outcome: ProbeResult["outcome"]): ProbeResult => ({
      target: "x",
      outcome,
      ms: 1,
    });
    expect(verdictOf([at("blocked"), at("blocked")])).toBe("guarded");
    expect(verdictOf([at("blocked"), at("refused")])).toBe("unguarded");
    expect(verdictOf([at("blocked"), at("timeout")])).toBe("unguarded");
    expect(verdictOf([at("connected")])).toBe("unguarded");
    expect(verdictOf([])).toBe("unguarded");
  });

  test("the metadata endpoint always; the private ranges and the host unless the deployment opted in", () => {
    expect(
      targetsFor({ allowPrivateHosts: false, gateway: "172.30.0.1" }),
    ).toEqual([
      { host: "169.254.169.254", port: 80 },
      { host: "10.255.255.1", port: 80 },
      { host: "172.30.0.1", port: 80 },
    ]);
    expect(
      targetsFor({ allowPrivateHosts: true, gateway: "172.30.0.1" }),
    ).toEqual([{ host: "169.254.169.254", port: 80 }]);
  });

  test("the host is read off the route table the way the kernel writes it", () => {
    const table = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask",
      "eth0\t0000FEAC\t00000000\t0001\t0\t0\t0\t0000FFFF",
      "eth0\t00000000\t0100FEAC\t0003\t0\t0\t0\t00000000",
    ].join("\n");
    expect(defaultGateway(table)).toBe("172.254.0.1");
    expect(defaultGateway("Iface\tDestination\tGateway\n")).toBeNull();
  });
});

describe("the guard in front of every browser", () => {
  test("refuses to open one on a machine whose host rules are missing, and says why once", async () => {
    const said: string[] = [];
    const guard = createEgressGuard({
      enforce: true,
      allowPrivateHosts: false,
      log: { ...quiet, error: (event) => void said.push(event) },
      probe: open,
      gateway: () => "172.30.0.1",
    });
    await expect(guard.ensureGuarded()).rejects.toBeInstanceOf(
      EgressUnguardedError,
    );
    expect(guard.state()).toBe("unguarded");
    await expect(guard.ensureGuarded()).rejects.toBeInstanceOf(
      EgressUnguardedError,
    );
    expect(said).toEqual(["egress_unguarded"]);
  });

  test("opens one once the host holds them, and closes the open one if they go", async () => {
    let now = 0;
    let answer = blocked;
    let closed = 0;
    const guard = createEgressGuard({
      enforce: true,
      allowPrivateHosts: false,
      log: quiet,
      probe: (targets) => answer(targets),
      gateway: () => "172.30.0.1",
      now: () => now,
      onUnguarded: () => {
        closed += 1;
      },
    });
    await guard.ensureGuarded();
    expect(guard.state()).toBe("guarded");

    answer = open;
    // Still fresh: no second probe for every browser handed out.
    await guard.ensureGuarded();
    now += 91_000;
    await expect(guard.ensureGuarded()).rejects.toBeInstanceOf(
      EgressUnguardedError,
    );
    expect(closed).toBe(1);

    // And heals on the first call after the host's unit has run again.
    answer = blocked;
    now += 6_000;
    await guard.ensureGuarded();
    expect(guard.state()).toBe("guarded");
  });

  test("off is the laptop's way past it: browsing goes ahead, and the state says off", async () => {
    const guard = createEgressGuard({
      enforce: false,
      allowPrivateHosts: true,
      log: quiet,
      probe: open,
      gateway: () => null,
    });
    await guard.ensureGuarded();
    await guard.check();
    expect(guard.state()).toBe("off");
  });
});
