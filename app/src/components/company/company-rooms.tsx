import { IconArrowLeft, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { RoomWorkingLine } from "./room-working-line";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  authorOf,
  type CompanyMember,
  type CompanyMessage,
  companyFailureText,
  companyKeys,
  companyMessagesQueryOptions,
  companyRoomsQueryOptions,
  companyWrite,
  keyFor,
  memberName,
  roomColleagues,
  type WriteKey,
} from "@/lib/hub/company";
import { asksLafi, LAFI_MENTION } from "@/lib/hub/room-working";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { cn } from "@/lib/utils";

/**
 * 방: the rooms this person is in, and one of them open — its newest messages, live, and a box to
 * write in. A message somebody else posts reaches this screen as a `hub.room.message` frame, which
 * makes the open room's read stale (`hubKeysForFrame`); nothing here polls.
 *
 * `rosterPending` is while who this person is and who the colleagues are is still being asked: a
 * room's messages wait for it, or this person's own would be drawn as somebody else's.
 */
export function CompanyRooms({
  members,
  meId,
  openRoom,
  rosterPending,
}: {
  members: readonly CompanyMember[] | undefined;
  meId: string | undefined;
  openRoom: string | undefined;
  rosterPending: boolean;
}) {
  const rooms = useQuery(companyRoomsQueryOptions());
  const room = rooms.data?.find((one) => one.id === openRoom);

  if (openRoom && room) {
    return (
      <OpenRoom
        meId={meId}
        members={members}
        name={room.name}
        people={room.members}
        roomId={room.id}
        rosterPending={rosterPending}
      />
    );
  }

  return (
    <div data-company-rooms>
      <NewRoom members={members} meId={meId} />
      {rooms.isPending ? (
        <PageRows>
          {[0, 1].map((slot) => (
            <div className="flex flex-col gap-2 p-4" key={slot}>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          ))}
        </PageRows>
      ) : rooms.isError ? (
        <PageEmpty>{companyFailureText(rooms.error)}</PageEmpty>
      ) : rooms.data.length === 0 ? (
        <PageEmpty>{t("No rooms yet.")}</PageEmpty>
      ) : (
        <PageRows>
          {rooms.data.map((one, index) => (
            <div key={one.id}>
              <Item
                render={(props) => (
                  <Link
                    data-company-room={one.id}
                    search={{ tab: "rooms", room: one.id }}
                    to="/company"
                    {...props}
                  />
                )}
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>{one.name}</ItemTitle>
                  <ItemDescription>
                    {one.members
                      .map((id) => memberName(id, members))
                      .join(", ")}
                  </ItemDescription>
                </ItemContent>
              </Item>
              {index !== rooms.data.length - 1 && <Separator />}
            </div>
          ))}
        </PageRows>
      )}
    </div>
  );
}

/** A room made here: a name, and who is in it besides the person making it. */
function NewRoom({
  members,
  meId,
}: {
  members: readonly CompanyMember[] | undefined;
  meId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const held = useRef<WriteKey | null>(null);
  const create = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), members: chosen };
      held.current = keyFor(
        held.current,
        JSON.stringify([body.name, [...chosen].sort()]),
      );
      return companyWrite("/api/hub/rooms", "POST", body, held.current.key);
    },
    onSuccess: () => {
      held.current = null;
      setName("");
      setChosen([]);
      setIsOpen(false);
      void queryClient.invalidateQueries({ queryKey: companyKeys.rooms });
    },
  });
  const others = roomColleagues(members, meId);

  if (!isOpen) {
    return (
      <div className="flex justify-end">
        <Button onClick={() => setIsOpen(true)} size="sm" variant="outline">
          <IconPlus />
          {t("New room")}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
      data-new-room
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Input
        aria-label={t("Room name")}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("Room name")}
        value={name}
      />
      {others.length > 0 ? (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <legend className="mb-1 text-muted-foreground text-xs">
            {t("Who is in it")}
          </legend>
          {others.map((member) => (
            <label className="flex items-center gap-1.5" key={member.id}>
              <input
                checked={chosen.includes(member.id)}
                onChange={(event) =>
                  setChosen((before) =>
                    event.target.checked
                      ? [...before, member.id]
                      : before.filter((id) => id !== member.id),
                  )
                }
                type="checkbox"
              />
              {memberName(member.id, members)}
            </label>
          ))}
        </fieldset>
      ) : null}
      {create.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {companyFailureText(create.error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => setIsOpen(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Cancel")}
        </Button>
        <Button
          disabled={!name.trim() || create.isPending}
          size="sm"
          type="submit"
        >
          {t("Make room")}
        </Button>
      </div>
    </form>
  );
}

function OpenRoom({
  meId,
  members,
  name,
  people,
  roomId,
  rosterPending,
}: {
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
  name: string;
  people: readonly string[];
  roomId: string;
  rosterPending: boolean;
}) {
  const messages = useQuery(companyMessagesQueryOptions(roomId));
  const newest = messages.data?.at(-1)?.seq ?? 0;
  const scroller = useRef<HTMLDivElement>(null);

  // To the newest whenever one arrives — this person's own or a colleague's.
  useEffect(() => {
    const element = scroller.current;
    if (element && newest > 0) element.scrollTop = element.scrollHeight;
  }, [newest]);

  return (
    <div className="flex flex-col gap-3" data-company-open-room={roomId}>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          aria-label={t("All rooms")}
          nativeButton={false}
          render={(props) => (
            <Link search={{ tab: "rooms" }} to="/company" {...props} />
          )}
          size="icon-sm"
          variant="ghost"
        >
          <IconArrowLeft />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-lg">{name}</h2>
          <p className="truncate text-muted-foreground text-xs">
            {people.map((id) => memberName(id, members)).join(", ")}
          </p>
        </div>
      </div>

      <div
        aria-live="polite"
        className="flex h-[55vh] min-h-48 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4"
        data-room-messages
        ref={scroller}
      >
        {messages.isPending || rosterPending ? (
          <Skeleton className="h-4 w-48" />
        ) : messages.isError ? (
          <p className="text-muted-foreground text-sm">
            {companyFailureText(messages.error)}
          </p>
        ) : messages.data.length === 0 ? (
          <p className="m-auto text-muted-foreground text-sm">
            {t("No messages yet.")}
          </p>
        ) : (
          messages.data.map((message) => (
            <RoomMessage
              key={message.seq}
              meId={meId}
              members={members}
              message={message}
            />
          ))
        )}
      </div>

      <RoomWorkingLine
        lines={messages.data}
        meId={meId}
        members={members}
        roomId={roomId}
      />
      <RoomComposer roomId={roomId} />
    </div>
  );
}

function RoomMessage({
  meId,
  members,
  message,
}: {
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
  message: CompanyMessage;
}) {
  const author = authorOf(message.by, members);
  const isMine = !author.isBot && author.memberId === meId;
  return (
    <div
      className={cn(
        "flex max-w-[85%] flex-col gap-0.5",
        isMine ? "self-end items-end" : "self-start items-start",
      )}
      data-room-message={message.seq}
    >
      <span className="text-muted-foreground text-xs">
        {isMine ? t("Me") : author.name} · {timeOf(message.at)}
      </span>
      <p
        className={cn(
          "whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm",
          isMine ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {message.text}
      </p>
    </div>
  );
}

function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The box a person writes in. Enter sends, Shift+Enter is a new line, and an Enter that finishes a
 * Korean syllable is the syllable's (`lib/ime.ts`). What was written stays in the box until the hub
 * has taken it, so a failed send loses nothing; the key follows the words (`keyFor`), so pressing
 * again after a dropped answer is the same message and an edit is a new one.
 */
function RoomComposer({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const held = useRef<WriteKey | null>(null);
  const send = useMutation({
    mutationFn: (written: string) => {
      // The same words again keep their key, so a retry after a dropped answer is one message;
      // edited words are another message and get a key of their own, or the hub would answer
      // the retry with the first write and the new text would never post.
      held.current = keyFor(held.current, written);
      return companyWrite(
        `/api/hub/rooms/${encodeURIComponent(roomId)}/messages`,
        "POST",
        // "@라피" asks the writer's own 라피, which answers from their VM (#259).
        { text: written, mentions: asksLafi(written) ? [LAFI_MENTION] : [] },
        held.current.key,
      );
    },
    onSuccess: () => {
      setText("");
      held.current = null;
      void queryClient.invalidateQueries({
        queryKey: companyKeys.messages(roomId),
      });
    },
  });
  const written = text.trim();
  const handleSend = () => {
    if (written && !send.isPending) send.mutate(written);
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        handleSend();
      }}
    >
      <div className="flex items-end gap-2">
        <Textarea
          aria-label={t("Message")}
          className="max-h-40 min-h-10"
          maxLength={4000}
          onChange={(event) => {
            setText(event.target.value);
            if (send.isError) send.reset();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || isImeKey(event)) {
              return;
            }
            event.preventDefault();
            handleSend();
          }}
          placeholder={t("Write a message")}
          rows={1}
          value={text}
        />
        <Button disabled={!written || send.isPending} type="submit">
          {t("Send")}
        </Button>
      </div>
      {send.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {companyFailureText(send.error)}
        </p>
      ) : null}
    </form>
  );
}
