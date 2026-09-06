import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal/legal-page";
import privacy from "@/legal/privacy.md?raw";

/** Public, like the terms — see `terms.tsx`. */
export const Route = createFileRoute("/legal/privacy")({
  component: () => <LegalPage document="privacy" markdown={privacy} />,
});
