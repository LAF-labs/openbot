import {
  type NodePath,
  type PluginObj,
  transformAsync,
  type types,
} from "@babel/core";
import ReactCompiler, {
  type LoggerEvent,
  OPT_OUT_DIRECTIVES,
} from "babel-plugin-react-compiler";
import { REACT_COMPILER_OPTIONS } from "../../src/lib/build/react-compiler";

/**
 * How much of the app the React Compiler actually compiles, read off the compiler's own logger.
 *
 * The compiler never fails the build over a function it cannot prove safe (`panicThreshold: "none"`);
 * it leaves that function exactly as written and says so to its logger, and to nobody else. This
 * runs the compiler the way `@vitejs/plugin-react` runs it in the build — the same options, the same
 * parser plugins per extension — over the modules it is given, and turns what the logger heard into
 * a count of functions compiled and a list of every function skipped, with the reason.
 */

export type Module = { path: string; source: string };

export type Skip = {
  /** The module, as it was given. */
  path: string;
  /** Where the function starts; 0 for something said about the module as a whole. */
  line: number;
  name: string;
  /** Everything the compiler said about this function, one line each. */
  reasons: string[];
  /** It opts out with "use no memo" and no comment above the directive says why. */
  unexplained?: true;
};

export type Coverage = {
  modules: number;
  compiled: number;
  skipped: Skip[];
};

type OptOut = { directive: string; explained: boolean };

type Place = { key: string; line: number; name: string; optOut?: OptOut };

const keyOf = (loc: { start: { line: number; column: number } }) =>
  `${loc.start.line}:${loc.start.column}`;

/** What a person reading the source would call this function. */
function nameOf(path: NodePath<types.Function>): string {
  const { node } = path;
  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression") &&
    node.id
  ) {
    return node.id.name;
  }
  // `const Row = memo(() => …)`, `forwardRef(function (…) {…})`: the name is the binding's.
  let owner: NodePath | null = path.parentPath;
  while (owner?.isCallExpression()) owner = owner.parentPath;
  if (owner?.isVariableDeclarator() && owner.node.id.type === "Identifier") {
    return owner.node.id.name;
  }
  if (
    (owner?.isObjectProperty() || owner?.isObjectMethod()) &&
    owner.node.key.type === "Identifier"
  ) {
    return owner.node.key.name;
  }
  if (owner?.isExportDefaultDeclaration()) return "default";
  return "(anonymous)";
}

/** A "use no memo" (or its older spelling) among these directives, and whether it says why. */
function optOutIn(directives: readonly types.Directive[]): OptOut | undefined {
  const found = directives.find((directive) =>
    OPT_OUT_DIRECTIVES.has(directive.value.value),
  );
  if (!found) return undefined;
  return {
    directive: found.value.value,
    explained: (found.leadingComments ?? []).length > 0,
  };
}

/**
 * The sentence for an opt-out. The compiler's own prints the directive's node rather than its
 * text — "Skipped due to '[object Object]' directive." — so it is written here instead.
 */
const optedOut = (optOut: OptOut, who: "It" | "The module") =>
  optOut.explained
    ? `${who} opts out with '${optOut.directive}'.`
    : `${who} opts out with '${optOut.directive}', and no comment above it says why.`;

/**
 * Runs before the compiler touches the file and remembers every function by where it starts.
 *
 * The compiler's events carry a location and no reliable name — `const Row = () => …`, the shape
 * every component here is written in, has no name of its own — and an opt-out reports where the
 * function's BODY starts, not the function. Both are recorded, so either finds the same function.
 */
const rememberFunctions = (
  places: Map<string, Place>,
  module: { optOut?: OptOut },
): PluginObj => ({
  name: "laf:remember-functions",
  visitor: {
    Program(program) {
      const moduleOptOut = optOutIn(program.node.directives);
      if (moduleOptOut) module.optOut = moduleOptOut;
      program.traverse({
        Function(fn) {
          const { loc, body } = fn.node;
          if (!loc) return;
          const optOut =
            body.type === "BlockStatement"
              ? optOutIn(body.directives)
              : undefined;
          const place: Place = {
            key: keyOf(loc),
            line: loc.start.line,
            name: nameOf(fn),
            ...(optOut ? { optOut } : {}),
          };
          places.set(place.key, place);
          if (body.loc) places.set(keyOf(body.loc), place);
        },
      });
    },
  },
});

/** One line for one thing the compiler said, or null for an event that is not about a skip. */
function describe(event: LoggerEvent, place: Place | undefined): string | null {
  switch (event.kind) {
    case "CompileError": {
      const { detail } = event;
      const at = detail.primaryLocation();
      const line =
        at && typeof at !== "symbol" ? ` (line ${at.start.line})` : "";
      return `${detail.category}: ${detail.reason}${line}`;
    }
    case "PipelineError":
      return `PipelineError: ${event.data.split("\n")[0]}`;
    case "CompileSkip":
      return place?.optOut ? optedOut(place.optOut, "It") : event.reason;
    default:
      // Successes are counted by the caller; timings and diagnostics skip nothing.
      return null;
  }
}

export async function measureModule(
  module: Module,
): Promise<{ compiled: number; skipped: Skip[] }> {
  const places = new Map<string, Place>();
  const scope: { optOut?: OptOut } = {};
  const skipped = new Map<string, Skip>();
  const compiled: Place[] = [];

  const skip = (place: Place, reason: string) => {
    const entry: Skip = skipped.get(place.key) ?? {
      path: module.path,
      line: place.line,
      name: place.name,
      reasons: [],
    };
    entry.reasons.push(reason);
    if (place.optOut && !place.optOut.explained) entry.unexplained = true;
    skipped.set(place.key, entry);
  };

  /** The function an event is about, however much of it the compiler could tell. */
  const placeOf = (fnLoc: types.SourceLocation | null): Place =>
    fnLoc
      ? (places.get(keyOf(fnLoc)) ?? {
          key: keyOf(fnLoc),
          line: fnLoc.start.line,
          name: "(anonymous)",
        })
      : /*
         * An error with no function is said about the module: a restricted import, say, which
         * stops the compiler before it looks at a single function. Nothing in that module compiles
         * and no function-level event says so — this line is the only trace of it.
         */
        { key: "module", line: 0, name: "(module)" };

  const logEvent = (_filename: string | null, event: LoggerEvent) => {
    if (event.kind === "CompileSuccess") {
      compiled.push(placeOf(event.fnLoc));
      return;
    }
    const fnLoc = "fnLoc" in event ? event.fnLoc : null;
    const place = placeOf(fnLoc);
    const reason = describe(event, place);
    if (reason !== null) skip(place, reason);
  };

  await transformAsync(module.source, {
    filename: module.path,
    babelrc: false,
    configFile: false,
    code: false,
    ast: false,
    parserOpts: {
      sourceType: "module",
      plugins: module.path.endsWith(".ts")
        ? ["typescript"]
        : ["jsx", "typescript"],
    },
    plugins: [
      rememberFunctions(places, scope),
      [
        ReactCompiler,
        {
          ...REACT_COMPILER_OPTIONS,
          panicThreshold: "none",
          logger: { logEvent },
        },
      ],
    ],
  });

  /*
   * A module that opens with "use no memo" is compiled and then thrown away, and the compiler logs
   * every function in it as a success. Counted that way, one line at the top of a file would take
   * every function in it off the list while the build compiled none of them.
   */
  const moduleOptOut = scope.optOut;
  if (moduleOptOut) {
    for (const place of compiled) {
      skip(
        { ...place, optOut: moduleOptOut },
        optedOut(moduleOptOut, "The module"),
      );
    }
    return { compiled: 0, skipped: [...skipped.values()] };
  }
  return { compiled: compiled.length, skipped: [...skipped.values()] };
}

export async function measureCompilerCoverage(
  modules: readonly Module[],
): Promise<Coverage> {
  let compiled = 0;
  const skipped: Skip[] = [];
  for (const module of modules) {
    const result = await measureModule(module);
    compiled += result.compiled;
    skipped.push(...result.skipped);
  }
  return { modules: modules.length, compiled, skipped };
}

export function formatCoverage(coverage: Coverage): string {
  const looked = coverage.compiled + coverage.skipped.length;
  const share =
    looked === 0 ? 0 : Math.round((coverage.compiled / looked) * 1000) / 10;
  const lines = [
    `React Compiler: ${coverage.compiled} of ${looked} components and hooks compiled (${share}%) ` +
      `across ${coverage.modules} modules; ${coverage.skipped.length} left as written.`,
  ];
  for (const skip of coverage.skipped) {
    lines.push(`  ${skip.path}:${skip.line}  ${skip.name}`);
    for (const reason of skip.reasons) lines.push(`      ${reason}`);
  }
  return lines.join("\n");
}
