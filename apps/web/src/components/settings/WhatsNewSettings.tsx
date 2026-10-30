import { localizedHighlight, releaseNotes } from "@t3tools/shared/releaseNotes";
import { useEffect } from "react";

import { OOP_VERSION } from "../../branding";
import { useT } from "../../i18n";
import { useWhatsNewPageUnseen } from "../../lib/whatsNew";
import { useUiLanguage } from "../../state/menuLanguage";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Release notes ship inside the client bundle, so the page works without any server connection. */
export function WhatsNewSettings() {
  const t = useT();
  const language = useUiLanguage();
  const formatDate = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" });
  const [unseen, markSeen] = useWhatsNewPageUnseen();

  useEffect(() => {
    if (unseen) markSeen();
  }, [unseen, markSeen]);

  return (
    <SettingsPageContainer>
      {releaseNotes.map((entry, index) => (
        <SettingsSection
          key={entry.version}
          // The search result and command palette land on the newest release.
          id={index === 0 ? "whats-new" : undefined}
          title={`OOP ${entry.version}`}
          headerAction={
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {entry.version === OOP_VERSION ? <Badge variant="info">{t("Current")}</Badge> : null}
              <time dateTime={entry.date}>{formatDate.format(new Date(entry.date))}</time>
            </span>
          }
        >
          {entry.highlights.map((highlight) => (
            <p key={highlight.en} className="px-3 py-2.5 text-base sm:px-4 sm:text-sm">
              {localizedHighlight(highlight, language)}
            </p>
          ))}
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
