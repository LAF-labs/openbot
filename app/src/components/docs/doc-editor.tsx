import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { PageEmpty } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HUB_FRAME,
  type HubFrame,
  hubFrames,
} from "@/lib/channels/use-channel-events";
import { type CompanyMember, memberName } from "@/lib/hub/company";
import {
  docFactText,
  docFailureText,
  lockBlock,
  openDocQueryOptions,
  readDoc,
  saveBlocks,
  unlockBlock,
} from "@/lib/hub/docs";
import { t } from "@/lib/i18n";
import { DocBlockView } from "./doc-block";
import {
  createDocController,
  type DocNotice,
  WRITABLE,
} from "./doc-controller";

/**
 * A team document, open for writing: block by block, like Notion, in our own code (design §5).
 *
 * LIVE BY NAME. A colleague's save, a hold taken or let go, 라피's change — each reaches this page as
 * a `hub.doc.*` frame (`lib/channels/use-channel-events.ts`), which names the document and never
 * carries it; the page reads the document again, once for a burst, and redraws the blocks nobody
 * here is writing in. The block being written in is never redrawn from a read
 * (`doc-controller.ts`).
 *
 * LEAVING LETS GO. Leaving the page, hiding the tab or closing it lets go of the held block, so a
 * colleague is not shown "쓰는 중" for a person who is gone; a tab that dies without saying so is let
 * go by the hub when the five-second renewals stop.
 */
export function DocEditor({
  docId,
  meId,
  members,
}: {
  docId: string;
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
}) {
  const query = useQuery(openDocQueryOptions(docId));
  const [controller] = useState(() =>
    createDocController({
      meId,
      doors: {
        read: () => readDoc(docId),
        save: (ops, key) => saveBlocks(docId, ops, key),
        lock: (blockId) => lockBlock(docId, blockId),
        unlock: (blockId) => unlockBlock(docId, blockId),
      },
    }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);

  useEffect(() => {
    controller.setMe(meId);
  }, [controller, meId]);

  useEffect(() => {
    if (query.data) controller.load(query.data);
  }, [controller, query.data]);

  useEffect(() => {
    const onFrame = (event: Event) => {
      const frame = (event as CustomEvent<HubFrame>).detail;
      if (isAboutDoc(frame, docId)) controller.changed();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") controller.leave();
    };
    const onPageHide = () => controller.leave();
    hubFrames.addEventListener(HUB_FRAME, onFrame);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      hubFrames.removeEventListener(HUB_FRAME, onFrame);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      controller.close();
    };
  }, [controller, docId]);

  if (!state.loaded) {
    if (query.isError)
      return <PageEmpty>{docFailureText(query.error)}</PageEmpty>;
    return (
      <div className="flex flex-col gap-3" data-doc-loading>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }

  const holderOf = (blockId: string): string | null => {
    const hold = state.holds.find((one) => one.blockId === blockId);
    return hold ? memberName(hold.memberId, members) : null;
  };
  const last = state.rows.at(-1);

  return (
    <div className="flex flex-col" data-doc-editor={docId}>
      {state.notice ? (
        <div
          className="mb-3 flex items-start justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm"
          data-doc-notice={state.notice.kind}
          role="status"
        >
          <span>{noticeText(state.notice, members)}</span>
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => controller.dismiss()}
            type="button"
          >
            {t("Close")}
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        {state.rows.map((row) => (
          <DocBlockView
            caret={state.caret}
            controller={controller}
            holderName={row.block.id ? holderOf(row.block.id) : null}
            isActive={state.activeKey === row.key}
            key={row.key}
            row={row}
          />
        ))}
      </div>
      {/* The space under the last block: a press there writes on, in a new block if the last one has text. */}
      <button
        aria-label={t("Write below")}
        className="min-h-24 w-full cursor-text"
        data-doc-below
        onClick={() => {
          if (!last) {
            controller.insertAfter(null, "paragraph", "");
          } else if (
            WRITABLE.has(last.block.kind) &&
            last.block.text === "" &&
            !holderOf(last.block.id)
          ) {
            controller.focus(last.key, "end");
          } else {
            controller.insertAfter(last.key, "paragraph", "");
          }
        }}
        type="button"
      />
    </div>
  );
}

/** A `hub.doc.*` frame that names this document, or names none (an older hub: read to be sure). */
export function isAboutDoc(frame: HubFrame, docId: string): boolean {
  if (!frame.kind.startsWith("hub.doc.")) return false;
  const ref = typeof frame.refId === "string" ? frame.refId : null;
  return ref === null || ref === docId || ref.startsWith(`${docId}:`);
}

function noticeText(
  notice: DocNotice,
  members: readonly CompanyMember[] | undefined,
): string {
  switch (notice.kind) {
    case "stale":
      return t("Somebody changed this block first. It now shows theirs.");
    case "busy":
      return notice.memberId
        ? t("{name} is writing in this block.", {
            name: memberName(notice.memberId, members),
          })
        : t("Somebody is writing in this block.");
    case "lost":
      return t("Somebody else started writing in this block.");
    case "failed":
      return docFactText(notice.code) ?? t("Could not save. Try again.");
  }
}
