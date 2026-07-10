// Workflow notification emails — fire-and-forget (never block the API
// response); silently skipped until RESEND_API_KEY is configured.
import { sendEmail } from "./index";

const base = () => process.env.APP_BASE_URL ?? "http://localhost:3100";

const shell = (title: string, body: string, cta: { href: string; label: string }) => `
  <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
    <div style="height:4px;background:linear-gradient(90deg,#003D5A,#792C38,#522B4C)"></div>
    <h2 style="color:#003D5A">${title}</h2>
    ${body}
    <p style="margin:24px 0"><a href="${cta.href}" style="background:#B9B400;color:#20200a;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${cta.label}</a></p>
  </div>`;

export function notifySubmission(args: {
  partnerEmail: string;
  partnerName: string;
  submitterName: string;
  count: number;
  matterCodes: string[];
}): void {
  void sendEmail({
    to: args.partnerEmail,
    subject: `Timesheets — ${args.count} ${args.count === 1 ? "entry" : "entries"} awaiting your approval`,
    html: shell(
      "Time submitted for your approval",
      `<p>Hi ${args.partnerName},</p>
       <p><b>${args.submitterName}</b> submitted <b>${args.count} ${args.count === 1 ? "entry" : "entries"}</b>
       on your ${args.matterCodes.length === 1 ? "matter" : "matters"} <b>${args.matterCodes.join(", ")}</b>.</p>`,
      { href: `${base()}/approvals`, label: "Review & approve" },
    ),
  }).catch(() => {});
}

export function notifySendBack(args: {
  ownerEmail: string;
  ownerName: string;
  partnerName: string;
  matterCode: string;
  description: string;
  note: string | null;
}): void {
  void sendEmail({
    to: args.ownerEmail,
    subject: `Timesheets — an entry on ${args.matterCode} was sent back`,
    html: shell(
      "Entry sent back for revision",
      `<p>Hi ${args.ownerName},</p>
       <p><b>${args.partnerName}</b> sent back your entry on <b>${args.matterCode}</b>:</p>
       <p style="color:#48606d">“${args.description}”</p>
       ${args.note ? `<p><b>Reason:</b> ${args.note}</p>` : ""}`,
      { href: `${base()}/timesheet`, label: "Fix & resubmit" },
    ),
  }).catch(() => {});
}
