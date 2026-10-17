import { IconPlus } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { focusRingBare } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A table block: a box per cell. The block is held while any of its cells has the caret, so a
 * colleague sees the whole table as "쓰는 중", and every cell's change saves the table's rows
 * together (`setTable`).
 *
 * A cell, like a block's box, owns its value while it has the caret: a colleague's save redraws the
 * other cells and never the one being written in, so a syllable being assembled is never touched.
 */
export function TableBlock({
  isReadOnly,
  onEnter,
  onLeave,
  onRows,
  rows,
}: {
  isReadOnly: boolean;
  /** The caret went into a cell. False when the table may not be written in now. */
  onEnter: () => boolean;
  onLeave: () => void;
  onRows: (rows: string[][]) => void;
  rows: string[][];
}) {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const grid = rows.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ""),
  );
  const holder = useRef<HTMLFieldSetElement>(null);

  const change = (rowIndex: number, cellIndex: number, value: string) => {
    onRows(
      grid.map((row, r) =>
        r === rowIndex
          ? row.map((cell, c) => (c === cellIndex ? value : cell))
          : row,
      ),
    );
  };

  return (
    <fieldset
      aria-label={t("Table")}
      className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
      data-doc-table
      onBlur={(event) => {
        // Moving between cells is still writing in the table; leaving it is not.
        if (!holder.current?.contains(event.relatedTarget as Node | null)) {
          onLeave();
        }
      }}
      ref={holder}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {grid.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position in the table.
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td
                    className="min-w-24 border border-border p-0 align-top"
                    // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its position.
                    key={cellIndex}
                  >
                    <TableCell
                      isReadOnly={isReadOnly}
                      label={t("Row {row}, column {column}", {
                        row: rowIndex + 1,
                        column: cellIndex + 1,
                      })}
                      onChange={(value) => change(rowIndex, cellIndex, value)}
                      onEnter={onEnter}
                      value={cell}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isReadOnly ? null : (
        <div className="flex gap-2 text-muted-foreground text-xs">
          <button
            className={cn(
              "flex items-center gap-1 rounded px-1 hover:text-foreground",
              focusRingBare,
            )}
            data-doc-table-add="row"
            onClick={() => {
              if (onEnter()) onRows([...grid, grid[0]?.map(() => "") ?? [""]]);
            }}
            type="button"
          >
            <IconPlus className="size-3" />
            {t("Row")}
          </button>
          <button
            className={cn(
              "flex items-center gap-1 rounded px-1 hover:text-foreground",
              focusRingBare,
            )}
            data-doc-table-add="column"
            onClick={() => {
              if (onEnter()) onRows(grid.map((row) => [...row, ""]));
            }}
            type="button"
          >
            <IconPlus className="size-3" />
            {t("Column")}
          </button>
        </div>
      )}
    </fieldset>
  );
}

function TableCell({
  isReadOnly,
  label,
  onChange,
  onEnter,
  value,
}: {
  isReadOnly: boolean;
  label: string;
  onChange: (value: string) => void;
  onEnter: () => boolean;
  value: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = box.current;
    // The cell with the caret is the person's; only the others take a colleague's text.
    if (
      element &&
      element !== document.activeElement &&
      element.value !== value
    ) {
      element.value = value;
    }
  }, [value]);

  return (
    <textarea
      aria-label={label}
      className={cn(
        "field-sizing-content block w-full resize-none bg-transparent px-2 py-1.5 outline-none",
        focusRingBare,
      )}
      data-doc-cell
      defaultValue={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={(event) => {
        if (!onEnter()) event.currentTarget.blur();
      }}
      readOnly={isReadOnly}
      ref={box}
      rows={1}
    />
  );
}
