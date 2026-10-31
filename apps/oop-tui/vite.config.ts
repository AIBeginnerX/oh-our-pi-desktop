import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      clean: true,
      sourcemap: false,
      format: "esm",
      platform: "node",
      outputOptions: { entryFileNames: "oop.mjs" },
      deps: {
        // Everything is inlined so the installed file needs nothing from this checkout.
        alwaysBundle: () => true,
        onlyBundle: false,
      },
      banner: { js: "#!/usr/bin/env node\n" },
    },
  }),
);
