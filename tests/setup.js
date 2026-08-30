import { vi } from "vitest";

// The app's SDK client is initialized against the live platform at import time.
// Domain-logic unit tests never touch the network, so stub it globally.
vi.mock("@/api/base44Client", () => ({
  base44: { entities: {}, auth: { me: async () => null }, users: {} },
}));