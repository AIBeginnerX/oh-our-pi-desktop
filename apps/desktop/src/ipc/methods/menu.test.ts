import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopApplicationMenu from "../../window/DesktopApplicationMenu.ts";
import { getMenuLanguage, setMenuLanguage } from "./menu.ts";

const makeMenuLayer = (configureCalls: Ref.Ref<number>) =>
  Layer.succeed(DesktopApplicationMenu.DesktopApplicationMenu, {
    configure: Ref.update(configureCalls, (count) => count + 1),
  } satisfies DesktopApplicationMenu.DesktopApplicationMenu["Service"]);

describe("menu language IPC", () => {
  it.effect("reads the persisted menu language", () =>
    Effect.gen(function* () {
      const result = yield* getMenuLanguage.handler(undefined).pipe(
        Effect.provide(
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            menuLanguage: "ja",
          }),
        ),
      );
      assert.equal(result, "ja");
    }),
  );

  it.effect("persists a new language and rebuilds the menu once", () =>
    Effect.gen(function* () {
      const configureCalls = yield* Ref.make(0);
      const result = yield* setMenuLanguage
        .handler("ko")
        .pipe(
          Effect.provide(
            Layer.mergeAll(DesktopAppSettings.layerTest(), makeMenuLayer(configureCalls)),
          ),
        );
      assert.equal(result, "ko");
      assert.equal(yield* Ref.get(configureCalls), 1);

      // Setting the same language again is a no-op for the menu.
      const again = yield* setMenuLanguage.handler("ko").pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              menuLanguage: "ko",
            }),
            makeMenuLayer(configureCalls),
          ),
        ),
      );
      assert.equal(again, "ko");
      assert.equal(yield* Ref.get(configureCalls), 1);
    }),
  );
});
