import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const BOUNCE_KEYWORDS = [
  "undeliverable",
  "delivery status notification",
  "failed delivery",
  "recipient not found",
  "invalid recipient",
  "address not found",
  "mailbox unavailable",
  "could not be delivered"
];

const BOUNCE_FROM_PATTERNS = [
  /mailer-daemon/i,
  /postmaster@/i,
  /\bmailerdaemon\b/i
];

export function buildMailerConfig(env = process.env) {
  const need = (key) => {
    const v = String(env[key] || "").trim();
    if (!v) throw new Error(`Missing required env var: ${key}`);
    return v;
  };

  const smtpSecure = String(env.SMTP_SECURE || "starttls").toLowerCase();
  return {
    smtp: {
      host: need("SMTP_HOST"),
      port: Number(env.SMTP_PORT || 587),
      secure: smtpSecure === "ssl" || smtpSecure === "tls",
      requireTLS: smtpSecure === "starttls",
      auth: { user: need("SMTP_USER"), pass: need("SMTP_PASS") }
    },
    imap: {
      host: need("IMAP_HOST"),
      port: Number(env.IMAP_PORT || 993),
      secure: String(env.IMAP_SECURE || "ssl").toLowerCase() !== "none",
      auth: { user: need("IMAP_USER"), pass: need("IMAP_PASS") }
    },
    sender: {
      name: String(env.SENDER_NAME || "").trim(),
      email: String(env.SENDER_EMAIL || env.SMTP_USER || "").trim(),
      company: String(env.SENDER_COMPANY || "").trim()
    }
  };
}

export function createMailer(config) {
  const transporter = nodemailer.createTransport(config.smtp);

  const fromHeader = config.sender.name
    ? `"${config.sender.name}" <${config.sender.email}>`
    : config.sender.email;

  return {
    config,
    async verify() {
      try {
        await transporter.verify();
      } catch (err) {
        throw setupError("SMTP", err);
      }
      let imap;
      try {
        imap = new ImapFlow({
          host: config.imap.host,
          port: config.imap.port,
          secure: config.imap.secure,
          auth: config.imap.auth,
          logger: false
        });
        await imap.connect();
      } catch (err) {
        throw setupError("IMAP", err);
      } finally {
        if (imap) {
          try { await imap.logout(); } catch { /* ignore */ }
        }
      }
    },
    async send({ to, subject, text, tag }) {
      const headers = tag ? { "X-Outreach-Tag": tag } : {};
      const info = await transporter.sendMail({
        from: fromHeader,
        to,
        subject,
        text,
        headers
      });
      return { messageId: info.messageId, sentAt: new Date() };
    },
    async checkBounce({ candidate, sentAt, tag, subject }) {
      const imap = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        auth: config.imap.auth,
        logger: false
      });
      try {
        await imap.connect();
      } catch (err) {
        throw setupError("IMAP", err);
      }

      try {
        const lock = await imap.getMailboxLock("INBOX");
        try {
          const since = new Date(sentAt.getTime() - 60 * 1000);
          const uids = await imap.search({ since });
          if (!uids?.length) return { bounced: false };

          const recent = uids.slice(-25);
          for await (const message of imap.fetch(recent, { source: true, envelope: true })) {
            if (await messageIndicatesBounce(message, { candidate, tag, subject })) {
              return { bounced: true, hint: message.envelope?.subject || "" };
            }
          }
          return { bounced: false };
        } finally {
          lock.release();
        }
      } finally {
        try { await imap.logout(); } catch { /* ignore */ }
      }
    },
    close() {
      transporter.close?.();
    }
  };
}

async function messageIndicatesBounce(message, { candidate, tag, subject }) {
  const envelopeSubject = String(message.envelope?.subject || "").toLowerCase();
  const fromAddrs = (message.envelope?.from || []).map((a) => `${a.mailbox || ""}@${a.host || ""}`.toLowerCase());

  const fromLooksLikeBounce = fromAddrs.some((addr) => BOUNCE_FROM_PATTERNS.some((re) => re.test(addr)));
  const subjectLooksLikeBounce = BOUNCE_KEYWORDS.some((kw) => envelopeSubject.includes(kw));
  if (!fromLooksLikeBounce && !subjectLooksLikeBounce) return false;

  let parsed;
  try {
    parsed = await simpleParser(message.source);
  } catch {
    return false;
  }

  const haystack = [
    parsed.text || "",
    parsed.html ? String(parsed.html) : "",
    parsed.subject || "",
    JSON.stringify(parsed.headers ? Object.fromEntries(parsed.headers) : {})
  ].join("\n").toLowerCase();

  const candidateLower = String(candidate || "").toLowerCase();
  const tagLower = String(tag || "").toLowerCase();
  const originalSubjectLower = String(subject || "").toLowerCase();

  const mentionsCandidate = candidateLower && haystack.includes(candidateLower);
  const mentionsTag = tagLower && haystack.includes(tagLower);
  const mentionsOriginalSubject = originalSubjectLower.length > 6 && haystack.includes(originalSubjectLower);

  if (!(mentionsCandidate || mentionsTag || mentionsOriginalSubject)) return false;

  return BOUNCE_KEYWORDS.some((kw) => haystack.includes(kw)) || fromLooksLikeBounce;
}

function setupError(label, err) {
  const message = err instanceof Error ? err.message : String(err);
  const hint = label === "SMTP"
    ? "Office 365 SMTP AUTH may be disabled for this mailbox; ask the tenant admin to enable SMTP AUTH or use an account with it allowed."
    : "Office 365 IMAP may be disabled for this mailbox; ask the tenant admin to enable IMAP access.";
  const error = new Error(`${label} setup failed: ${message}. ${hint}`);
  error.code = `${label}_SETUP_ERROR`;
  return error;
}
