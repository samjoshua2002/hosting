// Email accounts the Assistant can use: Gmail, Zoho Mail or any IMAP/SMTP mailbox, as many as you like, each
// connected with an app password (kept sealed in the vault). The Assistant searches and reads mail over IMAP,
// saves drafts into the account's Drafts folder, and sends over SMTP (sending waits for the user's approval).
// This is separate from the server's own report sender (EMAIL_USER), which only sends the fleet report.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { storeGetJson, storePut } from "./store";
import { forgetSecret, getSecret, setSecret } from "./vault";

const META = "assistant/mailboxes.json";

export type MailProvider = "gmail" | "zoho" | "zoho-in" | "custom";

export const MAIL_PROVIDERS: Record<Exclude<MailProvider, "custom">, { name: string; imap: string; smtp: string; help: string }> = {
  gmail: { name: "Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com", help: "https://myaccount.google.com/apppasswords" },
  zoho: { name: "Zoho Mail", imap: "imap.zoho.com", smtp: "smtp.zoho.com", help: "https://accounts.zoho.com/home#security/app_password" },
  "zoho-in": { name: "Zoho Mail (India)", imap: "imap.zoho.in", smtp: "smtp.zoho.in", help: "https://accounts.zoho.in/home#security/app_password" },
};

export interface Mailbox {
  id: string;
  email: string;
  name?: string;
  provider: MailProvider;
  imap: string;
  smtp: string;
  connectedAt: number;
}

const secretName = (id: string) => `MAILBOX_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export async function listMailboxes(): Promise<Mailbox[]> {
  return (await storeGetJson<Mailbox[]>(META).catch(() => null)) ?? [];
}

async function saveList(list: Mailbox[]) {
  await storePut(META, JSON.stringify(list));
}

function imapClient(m: Pick<Mailbox, "imap" | "email">, password: string) {
  return new ImapFlow({ host: m.imap, port: 993, secure: true, auth: { user: m.email, pass: password }, logger: false, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000 });
}

function smtpClient(m: Pick<Mailbox, "smtp" | "email">, password: string) {
  return nodemailer.createTransport({ host: m.smtp, port: 465, secure: true, auth: { user: m.email, pass: password }, connectionTimeout: 20_000 });
}

async function withImap<T>(m: Mailbox, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const password = await getSecret(secretName(m.id));
  if (!password) throw new Error(`${m.email} has no saved password: reconnect it in Settings → Connectors`);
  const c = imapClient(m, password);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => {});
  }
}

/** Check the address and app password against both IMAP and SMTP, then keep them. Same address again = update. */
export async function connectMailbox(input: { provider: MailProvider; email: string; password: string; name?: string; imap?: string; smtp?: string }): Promise<Mailbox> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("that doesn't look like an email address");
  const password = input.password.replace(/\s+/g, "");
  if (password.length < 6) throw new Error("paste the app password (not your normal password)");
  const preset = input.provider === "custom" ? null : MAIL_PROVIDERS[input.provider];
  if (!preset && input.provider !== "custom") throw new Error("unknown email provider");
  const imap = (preset?.imap ?? input.imap ?? "").trim().toLowerCase();
  const smtp = (preset?.smtp ?? input.smtp ?? "").trim().toLowerCase();
  if (!HOST.test(imap) || !HOST.test(smtp)) throw new Error("give the IMAP and SMTP server names (e.g. imap.example.com)");

  const probe = imapClient({ imap, email }, password);
  try {
    await probe.connect();
  } catch (e) {
    throw new Error(`${email} couldn't sign in over IMAP (${(e as Error & { responseText?: string }).responseText || (e as Error).message}). Use an app password and make sure IMAP is turned on in the mailbox settings.`);
  } finally {
    await probe.logout().catch(() => {});
  }
  try {
    await smtpClient({ smtp, email }, password).verify();
  } catch (e) {
    throw new Error(`${email} signed in for reading but not for sending (SMTP: ${(e as Error).message.slice(0, 160)})`);
  }

  const list = await listMailboxes();
  const existing = list.find((x) => x.email === email);
  const id = existing?.id ?? `mb${Date.now().toString(36)}`;
  await setSecret(secretName(id), password);
  const box: Mailbox = { id, email, name: input.name?.trim() || existing?.name, provider: input.provider, imap, smtp, connectedAt: Date.now() };
  await saveList([...list.filter((x) => x.id !== id), box]);
  return box;
}

export async function removeMailbox(idOrEmail: string): Promise<void> {
  const list = await listMailboxes();
  const box = list.find((x) => x.id === idOrEmail || x.email === idOrEmail.toLowerCase());
  if (!box) throw new Error("no such email account");
  await forgetSecret(secretName(box.id));
  await saveList(list.filter((x) => x.id !== box.id));
}

/** The account to use: by email or id, else the only/first one. */
export async function pickMailbox(account?: string): Promise<Mailbox> {
  const list = await listMailboxes();
  if (!list.length) throw new Error("No email account is connected. The user can add Gmail or Zoho Mail in Settings → Connectors (Email accounts).");
  if (!account) return list[0];
  const a = account.trim().toLowerCase();
  const box = list.find((x) => x.id === a || x.email === a) ?? list.find((x) => x.email.startsWith(a) || x.email.includes(a));
  if (!box) throw new Error(`No connected account matches "${account}". Connected: ${list.map((x) => x.email).join(", ")}`);
  return box;
}

export interface Draft {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: boolean;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

function message(box: Mailbox, d: Draft) {
  const from = box.name ? `"${box.name.replace(/"/g, "")}" <${box.email}>` : box.email;
  return {
    from,
    to: d.to,
    cc: d.cc || undefined,
    bcc: d.bcc || undefined,
    subject: d.subject,
    ...(d.html ? { html: d.body } : { text: d.body }),
    ...(d.attachments?.length ? { attachments: d.attachments } : {}),
  };
}

/** Save a draft in the account's Drafts folder (it shows up in Gmail / Zoho, ready to review and send). */
export async function saveDraft(account: string | undefined, d: Draft): Promise<string> {
  const box = await pickMailbox(account);
  const raw = await new MailComposer(message(box, d)).compile().build();
  return withImap(box, async (c) => {
    const boxes = await c.list();
    const drafts = boxes.find((b) => b.specialUse === "\\Drafts")?.path ?? boxes.find((b) => /(^|\/)drafts?$/i.test(b.path))?.path ?? "Drafts";
    await c.append(drafts, raw, ["\\Draft", "\\Seen"]);
    return `Draft saved in ${box.email} → ${drafts}: "${d.subject}" to ${d.to}${d.attachments?.length ? ` with ${d.attachments.map((a) => a.filename).join(", ")}` : ""}`;
  });
}

/** Send now over SMTP. */
export async function sendEmail(account: string | undefined, d: Draft): Promise<string> {
  const box = await pickMailbox(account);
  const password = await getSecret(secretName(box.id));
  if (!password) throw new Error(`${box.email} has no saved password: reconnect it in Settings → Connectors`);
  const info = await smtpClient(box, password).sendMail(message(box, d));
  return `Sent from ${box.email} to ${d.to}: "${d.subject}"${d.attachments?.length ? ` with ${d.attachments.map((a) => a.filename).join(", ")}` : ""} (${info.messageId ?? "accepted"})`;
}

/** Recent messages in a folder, newest first, optionally filtered (IMAP search). */
export async function searchEmail(account: string | undefined, q: { text?: string; from?: string; unseen?: boolean; folder?: string; limit?: number }): Promise<string> {
  const box = await pickMailbox(account);
  const limit = Math.min(Math.max(q.limit ?? 15, 1), 50);
  return withImap(box, async (c) => {
    const lock = await c.getMailboxLock(q.folder || "INBOX");
    try {
      const criteria: Record<string, unknown> = {};
      if (q.text) criteria.text = q.text;
      if (q.from) criteria.from = q.from;
      if (q.unseen) criteria.seen = false;
      const uids = ((await c.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true })) || []) as number[];
      const pick = uids.slice(-limit).reverse();
      if (!pick.length) return `${box.email} · ${q.folder || "INBOX"}: nothing matches.`;
      const lines: string[] = [];
      for await (const m of c.fetch(pick.join(","), { uid: true, envelope: true, flags: true }, { uid: true })) {
        const e = m.envelope;
        const from = e?.from?.[0] ? `${e.from[0].name ? `${e.from[0].name} ` : ""}<${e.from[0].address}>` : "?";
        lines.push(`uid ${m.uid} · ${e?.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : ""} · ${from} · ${e?.subject ?? "(no subject)"}${m.flags?.has("\\Seen") ? "" : " · unread"}`);
      }
      return `${box.email} · ${q.folder || "INBOX"} (newest first):\n${lines.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).join("\n")}`;
    } finally {
      lock.release();
    }
  });
}

/** One message's text (without marking it read). */
export async function readEmail(account: string | undefined, uid: number, folder = "INBOX"): Promise<string> {
  const box = await pickMailbox(account);
  return withImap(box, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m || !m.source) return `No message with uid ${uid} in ${folder}.`;
      const p = await simpleParser(m.source);
      const text = (p.text || (typeof p.html === "string" ? p.html.replace(/<[^>]+>/g, " ") : "") || "").replace(/\n{3,}/g, "\n\n").trim();
      const att = p.attachments?.length ? `\nAttachments: ${p.attachments.map((a) => `${a.filename ?? "file"} (${Math.round(a.size / 1024)} KB)`).join(", ")}` : "";
      return [`From: ${p.from?.text ?? "?"}`, `To: ${Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : (p.to?.text ?? "")}`, `Date: ${p.date?.toISOString() ?? ""}`, `Subject: ${p.subject ?? ""}`, "", text.slice(0, 20_000)].join("\n") + att;
    } finally {
      lock.release();
    }
  });
}

/** The catalog connector a mailbox belongs to (gmail / zoho-mail / imap). */
export function mailboxConnectorId(p: MailProvider): string {
  return p === "gmail" ? "gmail" : p === "custom" ? "imap" : "zoho-mail";
}

/** For the system prompt (without accounts switched off for this conversation). */
export async function mailboxSummary(off?: string[]): Promise<string> {
  const no = new Set((off ?? []).map((x) => x.toLowerCase()));
  const list = (await listMailboxes()).filter((m) => !no.has(m.email) && !no.has(mailboxConnectorId(m.provider)));
  if (!list.length) return "";
  return `Email accounts (use the email tool: search, read, draft, send; default account is the first): ${list.map((m) => `${m.email} (${m.provider === "custom" ? m.imap : MAIL_PROVIDERS[m.provider].name})`).join(", ")}`;
}
