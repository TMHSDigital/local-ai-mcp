import { z } from "zod";
import { PROVIDER_IDS } from "../providers/types.js";

/** Shared zod enum for optional/required provider tool args. */
export const providerIdZod = z.enum(PROVIDER_IDS);
