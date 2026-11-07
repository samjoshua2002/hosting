// Email alerts over Gmail SMTP (EMAIL_USER + an app password in EMAIL_PASS).
import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

export function alertRecipient(): string | undefined {
  return process.env.ALERT_EMAIL_TO || process.env.EMAIL_USER;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface MailItem {
  tone: "critical" | "warning" | "good" | "info";
  title: string;
  detail?: string;
}

/** Sends a styled alert email. Never throws: alerts must not break the request that triggered them. */
export async function sendAlert(subject: string, intro: string, items: MailItem[] = [], footer?: string): Promise<boolean> {
  if (!mailConfigured()) return false;
  try {
    transporter ??= nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: process.env.EMAIL_USER, pass: (process.env.EMAIL_PASS ?? "").replace(/\s+/g, "") },
    });
    const color = { critical: "#d03b3b", warning: "#fab219", good: "#0ca30c", info: "#7b88ff" };
    const app = process.env.APP_URL ?? "";
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#090b16;padding:24px;color:#eef0ff">
  <div style="max-width:560px;margin:0 auto;background:#11142a;border-radius:16px;padding:24px;border:1px solid #1d2140">
    <p style="margin:0;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a9b2ff;font-weight:700">Hosting Control</p>
    <h1 style="margin:6px 0 8px;font-size:22px;color:#fff">${esc(subject)}</h1>
    <p style="margin:0 0 16px;color:#b9bede;font-size:14px">${esc(intro)}</p>
    ${items
      .map(
        (i) => `<div style="border-left:3px solid ${color[i.tone]};background:#171b35;border-radius:8px;padding:10px 12px;margin:8px 0">
      <div style="font-weight:600;font-size:14px;color:#fff">${esc(i.title)}</div>
      ${i.detail ? `<div style="font-size:13px;color:#b9bede;margin-top:2px;white-space:pre-wrap">${esc(i.detail)}</div>` : ""}
    </div>`,
      )
      .join("")}
    ${footer ? `<p style="margin:16px 0 0;font-size:13px;color:#b9bede;white-space:pre-wrap">${esc(footer)}</p>` : ""}
    ${app ? `<p style="margin:20px 0 0"><a href="${esc(app)}" style="background:#fff;color:#0b0e1c;padding:9px 16px;border-radius:999px;text-decoration:none;font-weight:600;font-size:13px">Open dashboard</a></p>` : ""}
  </div>
</div>`;
    const text = [intro, ...items.map((i) => `- [${i.tone}] ${i.title}${i.detail ? `: ${i.detail}` : ""}`), footer ?? "", app].join("\n");
    await transporter.sendMail({
      from: `"Hosting Control" <${process.env.EMAIL_USER}>`,
      to: alertRecipient(),
      subject: `[hosting] ${subject}`,
      text,
      html,
    });
    return true;
  } catch (e) {
    console.error("[mail] send failed:", (e as Error).message);
    return false;
  }
}
