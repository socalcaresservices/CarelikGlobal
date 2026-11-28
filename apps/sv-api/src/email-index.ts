import { SESv2Client } from "@aws-sdk/client-sesv2";
import { createEmailHandler } from "./email-handler";

/** Lambda entry for the email function. SES_FROM is set by CDK from the environment configuration; without it the function refuses every call. */
const from = process.env.SES_FROM?.trim() ?? "";
const inner = from ? createEmailHandler(new SESv2Client({ region: process.env.AWS_REGION ?? "us-west-2" }), from, process.env.SES_CONFIGURATION_SET?.trim() || undefined, undefined, process.env.SES_REPLY_TO?.trim() || undefined, (process.env.SES_ALLOWED_RECIPIENTS ?? "").split(",").map((a) => a.trim()).filter(Boolean)) : null;
export const handler = async (event: Parameters<ReturnType<typeof createEmailHandler>>[0]) =>
  inner ? inner(event) : { ok: false as const, error: "not_configured", transient: false };
