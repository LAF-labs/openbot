import { useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type AgentProfileFormValues,
  agentProfileFormSchema,
} from "@/lib/agents/form";
import { t } from "@/lib/i18n";

/**
 * A BOT'S NAME AND WHAT IT DOES. That is the whole form.
 *
 * It used to be five fields and a disclosure: name, job title, role description, a public/private
 * select, and — for anybody the deployment counts as an administrator, which on a one-person
 * deployment is the shop owner themselves — an AG-UI endpoint and a bearer token.
 *
 * Three of those are gone from here:
 *
 * - Public/private decides nothing on a deployment where one person owns every Bot. The server
 *   still has the field and still defaults it to private; every PATCH carries the stored value back
 *   unchanged, which is why nothing here has to ask.
 * - The endpoint and its key are an operator's, and they now live on `/admin/bots`. Every Bot
 *   anybody makes here runs on this deployment's own endpoint by construction (CLAUDE.md), so for
 *   the person the product is for there was never an answer to type.
 * - The role description is a paragraph, and it has its own card on the profile — beside the
 *   effort setting and the standing allowance, which are the other two things that change how a
 *   Bot behaves.
 *
 * Cancel is back. The pane is no longer the form, so there is now something to cancel back to.
 */
export function AgentFields({
  defaultValues,
  onSubmit,
  error,
  onCancel,
}: {
  defaultValues: AgentProfileFormValues;
  onSubmit: (values: AgentProfileFormValues) => Promise<unknown>;
  error?: Error | null;
  onCancel?: () => void;
}) {
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
    validators: { onSubmit: agentProfileFormSchema },
  });

  return (
    <form
      className="w-full text-left"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="name">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>{t("Name")}</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  // The panel opens with nothing focused, so the first thing anybody does is reach
                  // for the mouse to click a field they were already looking at.
                  autoFocus
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={t("Expense Manager")}
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="title">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>
                  {t("What it does")}{" "}
                  <span className="font-normal text-muted-foreground">
                    {t("(Optional)")}
                  </span>
                </FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={t("Finance Operations")}
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
      </FieldGroup>

      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <Button
              disabled={!canSubmit || isSubmitting}
              size="sm"
              type="submit"
            >
              {isSubmitting ? t("Saving…") : t("Save")}
            </Button>
          )}
        </form.Subscribe>
        {onCancel ? (
          <Button onClick={onCancel} size="sm" type="button" variant="outline">
            {t("Cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
