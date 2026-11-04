import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
} from "react";
import { type EnvironmentId, type EnvironmentMachineKind } from "@t3tools/contracts";
import { FolderIcon, SettingsIcon } from "lucide-react";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import { SidebarHeaderIconButton } from "./sidebar/SidebarThreadHeader";
import {
  type SidebarProjectScopeMenuAction,
  type SidebarProjectScopeMenuState,
} from "./Sidebar.logic";
import { type SidebarProjectSnapshot } from "../sidebarProjectGrouping";

interface SidebarProjectScopeItem {
  readonly value: string;
  readonly label: string;
}

export function SidebarProjectScopePicker(props: {
  items: readonly SidebarProjectScopeItem[];
  filteredItems: readonly SidebarProjectScopeItem[];
  menuState: SidebarProjectScopeMenuState;
  dispatchMenu: Dispatch<SidebarProjectScopeMenuAction>;
  suppressNextScopeChangeRef: MutableRefObject<boolean>;
  highlightedProjectScopeKeyRef: MutableRefObject<string | null>;
  selectedItem: SidebarProjectScopeItem;
  setProjectScopeKey: (key: string | null) => void;
  scopedProjectGroup: SidebarProjectSnapshot | null;
  headerSearchRef: RefObject<HTMLDivElement | null>;
  projectGroupByScopeKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  showProjectEnvironments: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  environmentMachineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  handleProjectSettings: (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
    projectGroup: SidebarProjectSnapshot,
  ) => unknown;
}) {
  const t = useT();
  const {
    items: projectScopeItems,
    filteredItems: filteredProjectScopeItems,
    menuState: projectScopeMenuState,
    dispatchMenu: dispatchProjectScopeMenu,
    suppressNextScopeChangeRef,
    highlightedProjectScopeKeyRef,
    selectedItem: selectedProjectScopeItem,
    setProjectScopeKey,
    scopedProjectGroup,
    headerSearchRef,
    projectGroupByScopeKey,
    showProjectEnvironments,
    primaryEnvironmentId,
    environmentMachineById,
    handleProjectSettings,
  } = props;
  return (
    <Combobox
      items={projectScopeItems}
      filteredItems={filteredProjectScopeItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={projectScopeMenuState.open}
      onOpenChange={(open) => {
        if (open) suppressNextScopeChangeRef.current = false;
        dispatchProjectScopeMenu({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedProjectScopeKeyRef.current = item?.value ?? null;
      }}
      value={selectedProjectScopeItem}
      onValueChange={(item) => {
        if (suppressNextScopeChangeRef.current) {
          suppressNextScopeChangeRef.current = false;
          return;
        }
        if (!item) return;
        setProjectScopeKey(item.value === "all" ? null : item.value);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton
            label={
              scopedProjectGroup
                ? t("Filter threads by project: {name}", {
                    name: scopedProjectGroup.displayName,
                  })
                : t("Filter threads by project")
            }
          />
        }
      >
        {scopedProjectGroup ? (
          // Wrapped so the button's direct-child svg color rule cannot override
          // a project's own icon color.
          <span className="flex shrink-0">
            <ProjectFavicon project={scopedProjectGroup} className="size-4" />
          </span>
        ) : (
          <FolderIcon className="size-4" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        // Anchored to the search field, not the 28px trigger: the
        // popup opens under the field, is at least as wide as it,
        // and grows to fit project names up to a cap, past which
        // the rows truncate.
        anchor={headerSearchRef}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label={t("Search projects")}
          placeholder={t("Search projects...")}
          value={projectScopeMenuState.query}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
            ) {
              return;
            }
            // Combobox items use virtual focus: keyboard events
            // stay on this input, not on the highlighted option.
            const scopeKey = highlightedProjectScopeKeyRef.current;
            const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
            if (project) handleProjectSettings(event, project);
          }}
          onChange={(event) =>
            dispatchProjectScopeMenu({
              type: "query-changed",
              query: event.target.value,
            })
          }
        />
        <ComboboxEmpty>{t("No matching projects.")}</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof projectScopeItems)[number]) => {
            const project = projectGroupByScopeKey.get(item.value) ?? null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                onContextMenu={(event) => {
                  if (project) handleProjectSettings(event, project);
                }}
              >
                {project ? (
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {project && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={project}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
                {project ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.displayName}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      void handleProjectSettings(event, project);
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
