import pkg from "../package.json";
import type { Env } from "./env";

// Instance identity: what THIS deployment is called vs. what software it runs
// (the textpile / MeetingWords pattern). Instance branding is configuration;
// the software line in the footer is the attribution slot every deployment
// carries. Unconfigured, an instance is simply "Postilion".

export const SOFTWARE_NAME = "Postilion";
export const SOFTWARE_VERSION: string = pkg.version;
export const SOFTWARE_URL = "https://github.com/peterkaminski/postilion";
export const SOFTWARE_DOCS_URL = "https://postilion.peterkaminski.ai/docs/";

export interface InstanceInfo {
  /** Display name of this deployment (INSTANCE_NAME, else the software name). */
  name: string;
  /** True when INSTANCE_NAME sets a name of its own. */
  branded: boolean;
  software: { name: string; version: string; url: string };
}

export function instanceInfo(env: Env): InstanceInfo {
  const name = (env.INSTANCE_NAME || "").trim();
  return {
    name: name || SOFTWARE_NAME,
    branded: Boolean(name),
    software: { name: SOFTWARE_NAME, version: SOFTWARE_VERSION, url: SOFTWARE_URL },
  };
}
