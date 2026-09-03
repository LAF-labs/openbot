import type { McpCallResult, McpTool } from "./mcp";
import {
  asResult,
  countArg,
  failure,
  readJson,
  type RestConnection,
  stringArg,
  vendorRequest,
} from "./rest-support";

/**
 * Google Sheets over its ordinary REST API, read and write.
 *
 * WHY WRITE AND NOT JUST READ, unlike Drive. A spreadsheet is where a small business keeps the
 * thing it wants a Bot to put a row into — the day's orders, a call log, a stock count. A read-only
 * Sheets connector answers questions about a sheet nobody can then update, which is half of the one
 * job people ask for. The write half is what the boundary is for: `update_sheet_values` overwrites
 * and is guarded in the catalogue entry, so a person answers for it every time.
 *
 * The tool names are this repository's own, because Google publishes no MCP server for Sheets whose
 * names could be matched. They are stable from here on: a grant is stored as
 * `google-sheets/append_sheet_row`, and renaming one silently revokes it everywhere.
 */

/** How many rows a read hands back before the model is reading a database rather than an answer. */
const DEFAULT_ROWS = 50;
const MAX_ROWS = 500;

/**
 * A spreadsheet id, from an id or from the URL somebody pasted.
 *
 * People do not know their spreadsheets by id; they know them by the address bar, and a Bot told to
 * "이 시트에 추가해줘" is given a link. Extracting the id from `/spreadsheets/d/<id>/edit` costs one
 * regular expression and removes the most common way this connector fails for a reason nobody can
 * see. Anything that is not a URL is passed through as an id.
 */
export function spreadsheetIdFrom(value: string): string {
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : value;
}

// `annotations: null` throughout, like every curated adapter here: what a tool is allowed to do is
// the reviewed catalogue entry's word (`writeTools`, `guardedTools`), and a second declaration on
// the tool would be a source of truth that decides nothing.
const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_sheet_tabs",
    description:
      "구글 시트 문서 하나에 들어 있는 시트(탭) 이름과 크기를 알려준다. 어느 탭에 쓸지 정해야 할 때 먼저 부른다.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: {
          type: "string",
          description: "시트 문서의 id 또는 주소창의 링크",
        },
      },
      required: ["spreadsheetId"],
    },
    annotations: null,
  },
  {
    name: "read_sheet_values",
    description:
      "구글 시트에서 값을 읽는다. range는 '주문!A1:F50'처럼 탭 이름과 범위를 쓰고, 탭 전체를 읽으려면 '주문'만 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: {
          type: "string",
          description: "시트 문서의 id 또는 주소창의 링크",
        },
        range: {
          type: "string",
          description: "A1 표기 범위. 예: '주문!A1:F50' 또는 '주문'",
        },
        maxRows: {
          type: "number",
          description: `돌려줄 최대 행 수. 기본 ${DEFAULT_ROWS}`,
        },
      },
      required: ["spreadsheetId", "range"],
    },
    annotations: null,
  },
  {
    name: "append_sheet_row",
    description:
      "구글 시트의 표 맨 아래에 새 줄을 하나 추가한다. 기존 칸은 건드리지 않는다.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: {
          type: "string",
          description: "시트 문서의 id 또는 주소창의 링크",
        },
        range: {
          type: "string",
          description: "추가할 탭 이름. 예: '주문'",
        },
        values: {
          type: "array",
          items: { type: "string" },
          description: "한 줄에 왼쪽부터 넣을 값들",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
    annotations: null,
  },
  {
    name: "update_sheet_values",
    description:
      "구글 시트의 지정한 범위를 덮어쓴다. 그 자리에 있던 값은 사라지므로 사람에게 먼저 묻는다.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: {
          type: "string",
          description: "시트 문서의 id 또는 주소창의 링크",
        },
        range: {
          type: "string",
          description: "덮어쓸 A1 표기 범위. 예: '주문!B2:C3'",
        },
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "행의 배열. 각 행은 왼쪽부터의 값 배열",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
    annotations: null,
  },
]);

/** The list is this file, so nobody's credential is needed to know what this connector can do. */
export const listNeedsCredential = false;

export async function listTools(_connection: RestConnection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type SheetProperties = {
  properties?: {
    title?: string;
    gridProperties?: { rowCount?: number; columnCount?: number };
  };
};

/** A row of cells as one line a model can quote, with the columns kept apart. */
const rowLine = (row: unknown[]): string =>
  row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))).join(" | ");

/** Rows of strings out of whatever the model sent, or nothing usable. */
function rowsFrom(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
      : null,
  );
  return rows.every((row): row is string[] => row !== null) ? rows : null;
}

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const base = connection.url.replace(/\/+$/, "");
  const raw = stringArg(args, "spreadsheetId");
  if (!raw) return failure("시트 문서의 id 또는 링크가 필요합니다.");
  const sheetId = encodeURIComponent(spreadsheetIdFrom(raw));

  if (toolName === "list_sheet_tabs") {
    const result = await vendorRequest("Google Sheets", connection, {
      // Only the sheet list, not the cells: a whole spreadsheet's grid is not an answer to
      // "which tabs are there", and it is megabytes on a real one.
      url: `${base}/${sheetId}`,
      query: { fields: "properties.title,sheets.properties" },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{
      properties?: { title?: string };
      sheets?: SheetProperties[];
    }>(result.response);
    if (!body) return failure("구글 시트가 읽을 수 없는 답을 보냈습니다.");

    const lines = (body.sheets ?? []).map((sheet) => {
      const grid = sheet.properties?.gridProperties;
      const size = grid ? ` (${grid.rowCount ?? "?"}행 × ${grid.columnCount ?? "?"}열)` : "";
      return `- ${sheet.properties?.title ?? "(이름 없음)"}${size}`;
    });
    return asResult(
      [body.properties?.title ? `문서: ${body.properties.title}` : null, ...lines]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const range = stringArg(args, "range");
  if (!range) return failure("어느 범위인지 알려주세요. 예: '주문!A1:F50'");

  if (toolName === "read_sheet_values") {
    const result = await vendorRequest("Google Sheets", connection, {
      url: `${base}/${sheetId}/values/${encodeURIComponent(range)}`,
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ values?: unknown[][] }>(result.response);
    if (!body) return failure("구글 시트가 읽을 수 없는 답을 보냈습니다.");

    const limit = countArg(args, "maxRows", DEFAULT_ROWS, MAX_ROWS);
    const rows = body.values ?? [];
    const shown = rows.slice(0, limit).map(rowLine);
    // Said out loud rather than left to the model to notice the count: a truncated read that reads
    // like a complete one is how a Bot answers "이게 전부야" about half a sheet.
    const note =
      rows.length > shown.length
        ? `\n\n[${rows.length}행 중 ${shown.length}행만 보여줍니다. 더 필요하면 범위를 좁혀 다시 부르세요.]`
        : "";
    return asResult(`${shown.join("\n")}${note}`);
  }

  if (toolName === "append_sheet_row") {
    const values = args.values;
    const row = Array.isArray(values)
      ? values.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
      : null;
    if (!row || row.length === 0) return failure("추가할 값이 필요합니다.");

    const result = await vendorRequest("Google Sheets", connection, {
      url: `${base}/${sheetId}/values/${encodeURIComponent(range)}:append`,
      method: "POST",
      query: {
        // The values are what a person typed, so Sheets parses them the way it would if they had
        // been typed into the cell: a date stays a date and 010-… stays a phone number.
        valueInputOption: "USER_ENTERED",
        // Never over an existing row. Sheets' other mode overwrites whatever is below the table.
        insertDataOption: "INSERT_ROWS",
      },
      body: { values: [row] },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ updates?: { updatedRange?: string } }>(result.response);
    return asResult(`추가했습니다: ${body?.updates?.updatedRange ?? range}`);
  }

  if (toolName === "update_sheet_values") {
    const rows = rowsFrom(args.values);
    if (!rows) return failure("덮어쓸 값을 행의 배열로 주세요. 예: [[\"a\",\"b\"]]");

    const result = await vendorRequest("Google Sheets", connection, {
      url: `${base}/${sheetId}/values/${encodeURIComponent(range)}`,
      method: "PUT",
      query: { valueInputOption: "USER_ENTERED" },
      body: { values: rows },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ updatedCells?: number; updatedRange?: string }>(
      result.response,
    );
    return asResult(
      `${body?.updatedRange ?? range} 범위의 ${body?.updatedCells ?? 0}칸을 바꿨습니다.`,
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
