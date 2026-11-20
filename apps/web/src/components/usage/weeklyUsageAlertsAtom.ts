import { Atom } from "effect/unstable/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { selectWeeklyUsageAlerts } from "./weeklyUsageAlerts";

export const weeklyUsageAlertsAtom = Atom.make((get) =>
  selectWeeklyUsageAlerts(get(environmentPresentations.presentationsAtom)),
);

export const hasWeeklyUsageAlertAtom = Atom.make(
  (get) => get(weeklyUsageAlertsAtom).alerts.length > 0,
);
