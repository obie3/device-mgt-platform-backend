// ---------------------------------------------------------------------------
// Email provider interface
// ---------------------------------------------------------------------------
// Concrete implementations (Nodemailer/SMTP, transactional API, etc.) all
// implement this interface.  Notification code only imports these types — it
// never depends on a specific transport.

export interface EmailMessage {
  to:       string | string[];
  subject:  string;
  /** Full HTML body */
  html:     string;
  /** Optional plain-text fallback (auto-derived from html if omitted) */
  text?:    string;
  replyTo?: string;
  cc?:      string | string[];
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
