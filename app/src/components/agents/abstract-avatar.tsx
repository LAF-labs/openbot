import { Mascot } from "@/components/agents/mascot";

export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <Mascot className="size-full object-cover" seed={seed} size={size} />
    </span>
  );
}
