import { createFileRoute } from "@tanstack/react-router";

import { WhatsNewSettings } from "../components/settings/WhatsNewSettings";

export const Route = createFileRoute("/settings/whats-new")({
  component: WhatsNewSettings,
});
