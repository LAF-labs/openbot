import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal/legal-page";
import terms from "@/legal/terms.md?raw";

/**
 * Public on purpose: outside `_authed`, so the text a person is asked to agree to on the first
 * screen can be read before they have an account, and after they have deleted one.
 */
export const Route = createFileRoute("/legal/terms")({
  component: () => <LegalPage document="terms" markdown={terms} />,
});
