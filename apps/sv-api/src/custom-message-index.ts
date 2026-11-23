import { brandingFromEnvironment, createCustomMessageHandler, type CustomMessageEvent } from "./custom-message-handler";

/** Lambda entry for the Cognito custom-message trigger. A malformed company configuration disables branding (Cognito's own message is sent); it never throws. */
let inner: ReturnType<typeof createCustomMessageHandler>;
try { inner = createCustomMessageHandler(brandingFromEnvironment(process.env)); } catch { inner = createCustomMessageHandler(null); }
export const handler = (event: CustomMessageEvent) => inner(event);
