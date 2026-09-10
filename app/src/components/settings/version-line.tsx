import { useQuery } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  buildQueryOptions,
  describeBuild,
  shellVersionQueryOptions,
} from "@/lib/version";

/**
 * 버전 v0.4.5 (dba36c3) · 앱 0.2.0 — the line a support thread starts from.
 *
 * Under the legal links on Settings and on the help page, which are the two places a person who
 * has run out of ideas ends up. Two numbers because there are two things installed: the server's
 * build, which every surface shares, and the shell's own version, which only the shell can say.
 * In a browser tab the second half is absent rather than "web", because a footer that names a
 * surface is a footer somebody will read as a setting.
 *
 * Nothing is drawn until the server has answered, and nothing at all when it could not: a version
 * this line invents is exactly the wrong number for the thread to start from.
 */
export function VersionLine({ className }: { className?: string }) {
  const { data: build } = useQuery(buildQueryOptions());
  const { data: shell } = useQuery(shellVersionQueryOptions());

  if (!build) return null;

  const text = shell
    ? t("Version {build} · app {shell}", {
        build: describeBuild(build),
        shell,
      })
    : t("Version {build}", { build: describeBuild(build) });

  return (
    <p className={cn("text-muted-foreground text-xs", className)}>{text}</p>
  );
}
