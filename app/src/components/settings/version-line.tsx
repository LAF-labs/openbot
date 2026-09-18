import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  browserOf,
  buildQueryOptions,
  describeBuild,
  platformOf,
  shellVersionQueryOptions,
  supportLine,
} from "@/lib/version";

/** How long 복사했어요 stays before the button says 복사 again. */
const COPIED_MS = 1_500;

/**
 * 버전 v0.4.5 (dba36c3) · 앱 0.2.0 — the line a support thread starts from.
 *
 * Under the legal links on Settings and on the help page, which are the two places a person who
 * has run out of ideas ends up. Two numbers because there are two things installed: the server's
 * build, which every surface shares, and the shell's own version, which only the shell can say.
 * In a browser tab the second half is absent rather than "web", because a footer that names a
 * surface is a footer somebody will read as a setting.
 *
 * 복사 BESIDE IT, because reading a commit hash aloud over the phone is how that thread used to
 * start. It copies one plain line — the product, the build, the shell or the browser, the system —
 * built from the same two answers this line is drawn from, so what is pasted is what is on screen
 * plus the two facts a person would not know to look up. 복사했어요 appears only once the clipboard
 * took it: through `copyText`, the same door the copy button under a Bot's answer uses.
 *
 * Nothing is drawn until the server has answered, and nothing at all when it could not: a version
 * this line invents is exactly the wrong number for the thread to start from.
 */
export function VersionLine({ className }: { className?: string }) {
  const { data: build } = useQuery(buildQueryOptions());
  const { data: shell } = useQuery(shellVersionQueryOptions());
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!build) return null;

  const text = shell
    ? t("Version {build} · app {shell}", {
        build: describeBuild(build),
        shell,
      })
    : t("Version {build}", { build: describeBuild(build) });

  const handleCopy = async () => {
    const line = supportLine({
      product: appConfig.brand.productName,
      build,
      shell: shell ?? null,
      // The shell's webview names no browser of its own, and in the shell there is none to name.
      browser: shell ? null : browserOf(navigator),
      platform: platformOf(navigator),
    });
    if (!(await copyText(line))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2", className)}>
      <p className="text-muted-foreground text-xs">{text}</p>
      <Button
        aria-label={
          copied ? t("Copied to the clipboard") : t("Copy version details")
        }
        className="text-muted-foreground"
        onClick={() => void handleCopy()}
        size="xs"
        type="button"
        variant="ghost"
      >
        {copied ? t("Copied to the clipboard") : t("Copy")}
      </Button>
    </div>
  );
}
