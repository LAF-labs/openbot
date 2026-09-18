import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { BUSINESS_KINDS, type BusinessKindId } from "@/lib/shop/catalogue";

/**
 * 어떤 일을 하세요? — eight answers, one press.
 *
 * TWO COLUMNS OF EQUAL BUTTONS, not a dropdown. A dropdown hides the eight behind one control, and
 * the point of the question is that somebody sees their own trade in the list and presses it; a
 * grid is also the same shape on a phone and in the desktop window.
 *
 * Pressing the chosen one again takes it back, which is how a person who pressed by mistake gets to
 * "not answered" without a separate control — the first run then offers 건너뛰기 again.
 *
 * `aria-pressed`, the house grammar for "this is the one you picked" (`ui/focus.ts`), inside a
 * labelled group: a reader arriving on the fifth button hears which one is already chosen.
 */
export const BusinessKindPicker = ({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  /** What the group is called: the id of the heading asking the question, or the words. */
  label: { labelledBy: string } | { name: string };
  onChange: (kind: BusinessKindId | null) => void;
  value: BusinessKindId | null;
}) => (
  <fieldset
    {...("labelledBy" in label
      ? { "aria-labelledby": label.labelledBy }
      : { "aria-label": label.name })}
    // `min-w-0`: a fieldset's own minimum is its content's, which lets a long label push a grid wide.
    className="grid w-full min-w-0 grid-cols-2 gap-2"
  >
    {BUSINESS_KINDS.map((kind) => {
      const isChosen = value === kind.id;
      return (
        <Button
          aria-pressed={isChosen}
          className="h-11 whitespace-normal rounded-xl px-3 text-sm"
          disabled={disabled}
          key={kind.id}
          onClick={() => onChange(isChosen ? null : kind.id)}
          type="button"
          variant="outline"
        >
          {t(kind.name)}
        </Button>
      );
    })}
  </fieldset>
);
