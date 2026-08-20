import { IconBrandGoogleDrive, IconCloud } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { connectorListQueryOptions } from "@/lib/connectors/queries";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/admin/connectors")({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  const connectors = useQuery(connectorListQueryOptions());
  return (
    <PageShell
      description={t(
        "Available integrations are defined by this deployment’s knowledge sources.",
      )}
      title={t("Connectors")}
    >
      <PageSection title={t("Available")}>
        {connectors.isPending ? (
          <PageEmpty>{t("Loading connectors…")}</PageEmpty>
        ) : connectors.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("Could not load connectors.")}
          </p>
        ) : connectors.data?.length === 0 ? (
          <PageEmpty>
            {t(
              "No connectors. They come from this deployment's knowledge sources.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {connectors.data?.map((connector, index) => (
              <StaggerItem index={index} key={connector.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {connector.type === "google_drive" ? (
                      <IconBrandGoogleDrive />
                    ) : (
                      <IconCloud />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{connector.name}</ItemTitle>
                    <ItemDescription>
                      Roots: {connector.roots.join(", ")} ·{" "}
                      {connector.configured ? "Configured" : "Not configured"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {connector.type === "google_drive" ? (
                      <Button
                        render={<Link to="/admin/connectors/google-drive" />}
                        size="sm"
                        variant="outline"
                      >
                        {t("Set up")}
                      </Button>
                    ) : (
                      // Said rather than left blank, which would read as a control yet to arrive.
                      <span className="text-muted-foreground text-sm">
                        {t("No setup screen yet")}
                      </span>
                    )}
                  </ItemActions>
                </Item>
                {index !== (connectors.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
