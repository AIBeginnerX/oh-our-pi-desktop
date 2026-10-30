import { describe, expect, it } from "vite-plus/test";

import { isFailedServerListeningAgain, isLocalDevUrl } from "./previewUnreachableLogic";

describe("isLocalDevUrl", () => {
  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1:5173",
    "http://[::1]:8080/",
    "http://app.localhost:3000",
    "http://192.168.1.20:3000",
    "http://10.0.0.5:3000",
    "http://172.20.1.2:3000",
    "http://studio.local:3000",
  ])("treats %s as a dev server address", (url) => {
    expect(isLocalDevUrl(url)).toBe(true);
  });

  it.each(["https://example.com/", "http://172.32.0.1:3000", "http://8.8.8.8", "not a url"])(
    "does not treat %s as one",
    (url) => {
      expect(isLocalDevUrl(url)).toBe(false);
    },
  );
});

describe("isFailedServerListeningAgain", () => {
  const server = { url: "http://127.0.0.1:3000/", requestedUrl: "http://127.0.0.1:3000/" };

  it("is true when the refused port has a listener again, across loopback spellings", () => {
    expect(
      isFailedServerListeningAgain({
        failedUrl: "http://localhost:3000/app",
        errorDescription: "ERR_CONNECTION_REFUSED",
        servers: [server],
      }),
    ).toBe(true);
  });

  it("is false for another port or a failure that is not about the connection", () => {
    expect(
      isFailedServerListeningAgain({
        failedUrl: "http://localhost:3001/",
        errorDescription: "ERR_CONNECTION_REFUSED",
        servers: [server],
      }),
    ).toBe(false);
    expect(
      isFailedServerListeningAgain({
        failedUrl: "http://localhost:3000/",
        errorDescription: "ERR_CERT_AUTHORITY_INVALID",
        servers: [server],
      }),
    ).toBe(false);
  });

  it("matches a LAN address only against the same host", () => {
    const lan = { url: "http://192.168.1.20:3000/", requestedUrl: "http://192.168.1.20:3000/" };
    const input = { errorDescription: "ERR_CONNECTION_REFUSED", servers: [lan] };
    expect(isFailedServerListeningAgain({ ...input, failedUrl: "http://192.168.1.20:3000" })).toBe(
      true,
    );
    expect(isFailedServerListeningAgain({ ...input, failedUrl: "http://192.168.1.21:3000" })).toBe(
      false,
    );
  });
});
