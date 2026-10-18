import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CompanyMember } from "@/lib/hub/company";
import { assigneeLabel, type JobChoice } from "@/lib/hub/tasks";
import { t } from "@/lib/i18n";

/** The empty choice: given to nobody. A Select's value cannot be null. */
export const NOBODY = "none";

/**
 * Who a task is given to: nobody, this person's own 라피 (`bot:<me>`), a person in the company
 * (`m:<member>`), or one of this person's routines as a sub-Bot (`job:<routine id>`).
 */
export function AssigneeSelect({
  value,
  onChange,
  meId,
  members,
  jobs,
  disabled,
  canGive = () => true,
}: {
  value: string;
  onChange: (value: string) => void;
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
  jobs: readonly JobChoice[] | undefined;
  disabled?: boolean;
  /** Whether the task may be given to this choice as it stands; a choice that may not is not offered. */
  canGive?: (choice: string) => boolean;
}) {
  const context = { meId, members, jobs };
  const label = (choice: string) =>
    assigneeLabel(choice === NOBODY ? null : choice, context);
  const routines = (jobs ?? []).filter((job) => canGive(`job:${job.id}`));
  const people = [
    ...(members ?? []).filter((member) => member.id === meId),
    ...(members ?? []).filter((member) => member.id !== meId),
  ];
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={t("Who does it")}
        className="w-full sm:w-56"
        data-task-assignee
      >
        <SelectValue>{label(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOBODY}>{label(NOBODY)}</SelectItem>
        {meId && canGive(`bot:${meId}`) ? (
          <SelectItem
            data-assignee-option={`bot:${meId}`}
            value={`bot:${meId}`}
          >
            {label(`bot:${meId}`)}
          </SelectItem>
        ) : null}
        {people.length > 0 ? (
          <SelectGroup>
            <SelectLabel>{t("Teammates")}</SelectLabel>
            {people.map((member) => (
              <SelectItem
                data-assignee-option={`m:${member.id}`}
                key={member.id}
                value={`m:${member.id}`}
              >
                {label(`m:${member.id}`)}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {routines.length > 0 ? (
          <SelectGroup>
            <SelectLabel>{t("My routines")}</SelectLabel>
            {routines.map((job) => (
              <SelectItem
                data-assignee-option={`job:${job.id}`}
                key={job.id}
                value={`job:${job.id}`}
              >
                {label(`job:${job.id}`)}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
