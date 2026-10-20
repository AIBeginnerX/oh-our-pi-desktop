import { createProjectSkillAtoms } from "@t3tools/client-runtime/state/project-skills";

import { connectionAtomRuntime } from "../connection/runtime";

/** Web instantiation of the shared project-skill atoms. */
export const projectSkills = createProjectSkillAtoms(connectionAtomRuntime);
