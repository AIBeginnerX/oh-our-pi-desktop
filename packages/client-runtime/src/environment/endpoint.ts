export * from "@t3tools/shared/advertisedEndpoint";

/**
 * Joins `pathname` under the base URL's own path, so an environment the host forwards at
 * `/_gw/<id>` keeps its prefix. A root base leaves `pathname` untouched.
 */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = url.pathname.replace(/\/+$/u, "") + pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Resolves a server-relative URL (such as an asset link) under the environment's base path. */
export const resolveEnvironmentUrl = (httpBaseUrl: string, relativeUrl: string): string => {
  const base = new URL(httpBaseUrl);
  if (relativeUrl.startsWith("/") && !relativeUrl.startsWith("//")) {
    return new URL(base.pathname.replace(/\/+$/u, "") + relativeUrl, base).toString();
  }
  return new URL(relativeUrl, base).toString();
};
