import { BotAvatarPicker } from "@/components/avatar/bot-avatar-picker";

/**
 * The old name for the face picker, kept while the profile screen that calls it is rewritten.
 *
 * Same props, same contract — one press applies, there is no Save — over
 * `components/avatar/bot-avatar-picker.tsx`. It goes when `agent-profile.tsx` stops importing it.
 */
export function MascotPicker({
  open,
  onOpenChange,
  seed,
  onSelect,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: string | undefined;
  onSelect: (id: string) => void;
  pending?: boolean;
}) {
  return (
    <BotAvatarPicker
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      open={open}
      pending={pending}
      seed={seed}
    />
  );
}
