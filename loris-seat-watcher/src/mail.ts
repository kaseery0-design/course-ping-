import nodemailer from "nodemailer";

export type SmtpEnv = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

export function smtpFromEnv(): SmtpEnv {
  const opt = smtpFromEnvOptional();
  if (!opt) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST and SMTP_USER in .env (see .env.example), " +
        "or run `npm run check -- --dry-run` / set SKIP_EMAIL=1 to print results only.",
    );
  }
  return opt;
}

/** Returns null if SMTP_HOST or SMTP_USER is missing. */
export function smtpFromEnvOptional(): SmtpEnv | null {
  const host = process.env.SMTP_HOST ?? "";
  const port = Number(process.env.SMTP_PORT ?? "587");
  const secure = (process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";
  const from = process.env.EMAIL_FROM ?? user;
  if (!host || !user) return null;
  return { host, port, secure, user, pass, from };
}

export async function sendMail(opts: {
  smtp: SmtpEnv;
  to: string;
  subject: string;
  text: string;
}) {
  const transporter = nodemailer.createTransport({
    host: opts.smtp.host,
    port: opts.smtp.port,
    secure: opts.smtp.secure,
    auth: { user: opts.smtp.user, pass: opts.smtp.pass },
  });
  await transporter.sendMail({
    from: opts.smtp.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  });
}
