import { createProjectMemoryAtoms } from "@t3tools/client-runtime/state/project-memory";

import { connectionAtomRuntime } from "../connection/runtime";

/** Web instantiation of the shared project-memory atoms. */
export const projectMemory = createProjectMemoryAtoms(connectionAtomRuntime);
